/**
 * server.js
 *
 * - logAxiosError(tag, err) => prints full axios error info for debugging
 * - /admin/send-doc?to=...&media=... => trigger doc send from inside Railway (optional ADMIN_KEY to protect)
 * - Non-blocking background doc send: quick text returned to user, webhook acked, doc send runs in background
 * - Increased timeouts & retries for doc sends, multipart fallback
 *
 * Env vars:
 *  - SEND_API_KEY (required)
 *  - INTRO_TEXT, INTERACTIVE_BODY, TV_LINK, TV_MEDIA_ID, AC_LINK, AC_MEDIA_ID, etc (required as before)
 *  - SEND_TEXT_URL (default gate.whapi.cloud/messages/text)
 *  - SEND_DOC_URL  (default gate.whapi.cloud/messages/document)
 *  - SEND_INTERACTIVE_URL (default gate.whapi.cloud/messages/interactive)
 *  - VERIFY_TOKEN (optional)
 *  - SENDER_PHONE (optional)
 *  - PDF_FILENAME (optional, default document.pdf)
 *  - TEXT_TIMEOUT_MS (default 8000)
 *  - DOC_TIMEOUT_MS  (default 30000)
 *  - DOC_RETRIES     (default 1)
 *  - ADMIN_KEY       (optional) - if set, /admin/send-doc requires header X-ADMIN-KEY with this value
 */

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const FormData = require("form-data");
const LRU = require("lru-cache");
const morgan = require("morgan");

const app = express();
app.use(bodyParser.json({ limit: "500kb" }));
app.use(morgan("combined"));

/* --------- CONFIG / ENV --------- */
const PORT = process.env.PORT || 8080;
const SEND_API_KEY = process.env.SEND_API_KEY;
const SEND_TEXT_URL = process.env.SEND_TEXT_URL || "https://gate.whapi.cloud/messages/text";
const SEND_DOC_URL = process.env.SEND_DOC_URL || "https://gate.whapi.cloud/messages/document";
const SEND_INTERACTIVE_URL = process.env.SEND_INTERACTIVE_URL || "https://gate.whapi.cloud/messages/interactive";

const INTRO_TEXT = process.env.INTRO_TEXT || "Hi, I'm Dileep, and I want to share my favourite products with you!";
const INTERACTIVE_BODY = process.env.INTERACTIVE_BODY || "Choose which category you are interested in:";
const TV_BUTTON_TITLE = process.env.TV_BUTTON_TITLE || "TV";
const TV_BUTTON_ID = process.env.TV_BUTTON_ID || "tv";
const TV_LINK = process.env.TV_LINK || "";
const TV_MEDIA_ID = process.env.TV_MEDIA_ID || "";
const AC_BUTTON_TITLE = process.env.AC_BUTTON_TITLE || "AC";
const AC_BUTTON_ID = process.env.AC_BUTTON_ID || "ac";
const AC_LINK = process.env.AC_LINK || "";
const AC_MEDIA_ID = process.env.AC_MEDIA_ID || "";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || null;
const SENDER_PHONE = process.env.SENDER_PHONE || null;
const PDF_FILENAME = process.env.PDF_FILENAME || "document.pdf";

const DEDUPE_TTL_MIN = parseInt(process.env.DEDUPE_TTL_MIN || "5", 10);
const DEDUPE_TTL_MS = DEDUPE_TTL_MIN * 60 * 1000;
const MAX_DEDUPE_ENTRIES = parseInt(process.env.MAX_DEDUPE_ENTRIES || "10000", 10);

// Tunables for performance/debugging
const TEXT_TIMEOUT_MS = parseInt(process.env.TEXT_TIMEOUT_MS || "8000", 10);
const DOC_TIMEOUT_MS = parseInt(process.env.DOC_TIMEOUT_MS || "30000", 10); // increase if needed
const DOC_RETRIES = parseInt(process.env.DOC_RETRIES || "1", 10);
const ADMIN_KEY = process.env.ADMIN_KEY || null; // optional admin protection

if (!SEND_API_KEY) {
  console.error("Missing SEND_API_KEY. Aborting.");
  process.exit(1);
}
if (!TV_LINK || !TV_MEDIA_ID || !AC_LINK || !AC_MEDIA_ID) {
  console.error("Missing TV/AC link or media env vars. Aborting.");
  process.exit(1);
}

/* --------- UTILITIES --------- */

/** Detailed axios error logger for debugging. Use before cutting logs. */
function logAxiosError(tag, err) {
  try {
    console.error(`--- ${tag} - Error:`, err?.message || err);
    if (err?.code) console.error(`${tag} - code:`, err.code);
    if (err?.config) {
      // ensure we don't log huge binaries
      const cfg = {
        url: err.config.url,
        method: err.config.method,
        headers: err.config.headers,
        data: typeof err.config.data === "string" ? err.config.data.slice(0, 2000) : err.config.data,
      };
      console.error(`${tag} - request:`, JSON.stringify(cfg));
    }
    if (err?.response) {
      console.error(`${tag} - response.status:`, err.response.status);
      // headers may be large; truncate
      try {
        console.error(`${tag} - response.headers:`, JSON.stringify(err.response.headers).slice(0, 2000));
      } catch {}
      try {
        console.error(`${tag} - response.body:`, JSON.stringify(err.response.data).slice(0, 8000));
      } catch {
        console.error(`${tag} - response.body: (could not stringify)`);
      }
    }
  } catch (ex) {
    console.error("Failed to log axios error fully", ex);
  }
}

/* normalize phone/JID into accepted `to` form */
function normalizePhone(raw) {
  if (!raw || typeof raw !== "string") return null;
  raw = raw.trim();
  if (raw.includes("@")) {
    const parts = raw.split("@");
    let user = parts[0].replace(/\D+/g, "");
    const domain = parts.slice(1).join("@");
    if (!user) return null;
    return `${user}@${domain}`;
  } else {
    const digits = raw.replace(/\D+/g, "");
    return digits.length >= 9 ? digits : null;
  }
}

/* small sleep helper for backoff */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* --------- DEDUPE / HEALTH --------- */
const dedupe = new LRU({ max: MAX_DEDUPE_ENTRIES, ttl: DEDUPE_TTL_MS });

app.get("/health", (req, res) =>
  res.json({ status: "ok", tv_media: !!TV_MEDIA_ID, ac_media: !!AC_MEDIA_ID })
);

/* --------- WHAPI SEND HELPERS --------- */

/* send text using authoritative Whapi shape { to, body } */
async function sendText(toPhone, bodyText) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, "Content-Type": "application/json" };
  const payload = { to: String(toPhone), body: String(bodyText) };
  return axios.post(SEND_TEXT_URL, payload, { headers, timeout: TEXT_TIMEOUT_MS });
}

/* single-attempt JSON document send */
async function sendDocumentJsonOnce(toPhone, mediaId, timeoutMs) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, "Content-Type": "application/json" };
  const payload = { to: String(toPhone), media: String(mediaId), filename: PDF_FILENAME, type: "document" };
  return axios.post(SEND_DOC_URL, payload, { headers, timeout: timeoutMs });
}

/* single-attempt multipart send */
async function sendDocumentMultipartOnce(toPhone, mediaId, timeoutMs) {
  const form = new FormData();
  form.append("to", String(toPhone));
  form.append("media", String(mediaId));
  form.append("filename", PDF_FILENAME);
  form.append("type", "document");
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, ...form.getHeaders() };
  return axios.post(SEND_DOC_URL, form, { headers, maxContentLength: Infinity, maxBodyLength: Infinity, timeout: timeoutMs });
}

/**
 * Robust document sender: tries JSON then multipart, retries the sequence DOC_RETRIES times with backoff.
 * Returns axios response on success, throws last error on failure.
 */
async function sendDocumentRobust(toPhone, mediaId) {
  let lastErr = null;
  for (let attempt = 0; attempt <= DOC_RETRIES; attempt++) {
    const name = `docAttempt#${attempt + 1}`;
    try {
      console.log(`${name}: trying JSON send (timeout ${DOC_TIMEOUT_MS}ms)`);
      const resp = await sendDocumentJsonOnce(toPhone, mediaId, DOC_TIMEOUT_MS);
      console.log(`${name}: JSON success status=${resp.status}`);
      return resp;
    } catch (errJson) {
      lastErr = errJson;
      logAxiosError(`${name} JSON`, errJson);
      // bail early on auth issues
      const st = errJson?.response?.status;
      if (st && [401, 403].includes(st)) throw errJson;

      // try multipart fallback for this attempt
      try {
        console.log(`${name}: trying multipart fallback (timeout ${DOC_TIMEOUT_MS}ms)`);
        const resp2 = await sendDocumentMultipartOnce(toPhone, mediaId, DOC_TIMEOUT_MS);
        console.log(`${name}: multipart success status=${resp2.status}`);
        return resp2;
      } catch (errMulti) {
        lastErr = errMulti;
        logAxiosError(`${name} multipart`, errMulti);
        const st2 = errMulti?.response?.status;
        if (st2 && [401, 403].includes(st2)) throw errMulti;
      }
    }
    if (attempt < DOC_RETRIES) {
      const backoff = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s...
      console.log(`Waiting ${backoff}ms before next doc attempt`);
      await sleep(backoff);
    }
  }
  throw lastErr || new Error("Document send failed after retries");
}

/* interactive send */
async function sendInteractiveButtons(toPhone) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, "Content-Type": "application/json" };
  const payload = {
    body: { text: INTERACTIVE_BODY },
    action: {
      buttons: [
        { type: "quick_reply", title: TV_BUTTON_TITLE, id: TV_BUTTON_ID },
        { type: "quick_reply", title: AC_BUTTON_TITLE, id: AC_BUTTON_ID }
      ]
    },
    type: "button",
    to: String(toPhone)
  };
  return axios.post(SEND_INTERACTIVE_URL, payload, { headers, timeout: TEXT_TIMEOUT_MS });
}

/* extract incoming and ignore statuses/from_me echoes */
function extractCommon(body) {
  if (!body) return { kind: "unknown", raw: body };
  if (Array.isArray(body.statuses) && body.statuses.length > 0) return { kind: "status", statuses: body.statuses, raw: body };
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const m = body.messages[0];
    return {
      kind: "message",
      messageId: m.id || m.msg_id || m.message_id || null,
      from: m.from || m.sender || m.chat_id || null,
      from_me: !!m.from_me,
      text: m?.text?.body || m?.body || null,
      raw: m
    };
  }
  if (body.message) {
    const m = body.message;
    return { kind: "message", messageId: m.id || null, from: m.from || m.sender || null, from_me: !!m.from_me, text: m?.text?.body || m?.body || null, raw: m };
  }
  return { kind: "unknown", raw: body };
}

/* robust button reply extractor */
function extractButtonReply(body) {
  if (!body) return null;
  const m = (body.messages && body.messages[0]) || body.message || body;
  if (m?.interactive?.button_reply) return { id: m.interactive.button_reply.id, title: m.interactive.button_reply.title };
  if (m?.reply?.buttons_reply) return { id: m.reply.buttons_reply.id, title: m.reply.buttons_reply.title };
  if (m?.reply && (m.reply.id || m.reply.title)) return { id: m.reply.id || null, title: m.reply.title || null };
  return null;
}
function normalizeButtonId(rawId) {
  if (!rawId) return null;
  const parts = String(rawId).split(":");
  return parts[parts.length - 1].toLowerCase();
}

/* --------- ADMIN endpoint - run doc send from server environment --------- */
/* Optional protection: if ADMIN_KEY is set, require header X-ADMIN-KEY */
app.post("/admin/send-doc", async (req, res) => {
  try {
    if (ADMIN_KEY) {
      const key = req.headers["x-admin-key"];
      if (!key || key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "invalid admin key" });
    }
    const to = req.query.to;
    const media = req.query.media;
    if (!to || !media) return res.status(400).json({ ok: false, error: "missing to or media query params (use ?to=...&media=...)" });

    // Normalize to like our webhook
    const normTo = normalizePhone(to) || to;
    try {
      const resp = await sendDocumentRobust(normTo, media);
      return res.status(200).json({ ok: true, status: resp.status, body: resp.data });
    } catch (err) {
      logAxiosError("admin send-doc", err);
      return res.status(500).json({ ok: false, error: err?.message || "send failed" });
    }
  } catch (ex) {
    console.error("admin/send-doc error", ex);
    return res.status(500).json({ ok: false, error: "server error" });
  }
});

/* --------- MAIN WEBHOOK --------- */
app.post("/webhook", async (req, res) => {
  try {
    if (VERIFY_TOKEN) {
      const token = req.headers["x-whapi-token"] || req.headers["x-webhook-token"] || null;
      if (token !== VERIFY_TOKEN) {
        console.warn("invalid webhook token");
        return res.status(401).send("invalid token");
      }
    }

    const incoming = extractCommon(req.body);

    if (incoming.kind === "status") {
      console.log("Received statuses event - ignoring");
      return res.status(200).send("ignored-status");
    }
    if (incoming.kind !== "message") {
      console.log("Unknown webhook kind - ignoring", JSON.stringify(incoming.raw).slice(0,300));
      return res.status(200).send("ignored");
    }
    if (incoming.from_me) {
      console.log("Ignoring from_me echo");
      return res.status(200).send("ignored-from-me");
    }

    const messageId = incoming.messageId || Date.now().toString();
    const rawFrom = incoming.from;
    const from = normalizePhone(rawFrom);
    if (!from) {
      console.warn("no 'from' in incoming payload or invalid format:", JSON.stringify(incoming.raw).slice(0,400));
      return res.status(400).send("missing-sender");
    }

    if (SENDER_PHONE) {
      const normSender = normalizePhone(SENDER_PHONE);
      if (normSender && from === normSender) {
        console.log("Ignoring message from configured sender phone (self)");
        return res.status(200).send("ignored-self");
      }
    }

    if (dedupe.get(messageId)) {
      console.log("Duplicate webhook ignored", messageId);
      return res.status(200).send("ok");
    }
    dedupe.set(messageId, true);

    // detect button reply
    const btn = extractButtonReply(req.body);
    if (btn && btn.id) {
      const normalizedId = normalizeButtonId(btn.id);
      console.log("Button reply detected:", btn.id, btn.title, "->", normalizedId);

      // send text immediately, then ACK webhook, then background doc send
      if (normalizedId === (TV_BUTTON_ID || "tv").toLowerCase()) {
        // send immediate link to user (await so message is posted quickly)
        try {
          await sendText(from, TV_LINK);
        } catch (errText) {
          logAxiosError("sendText (tv) failed", errText);
          // still proceed to ack and try sending doc in background
        }

        // ACK webhook quickly
        res.status(200).send("accepted-tv");

        // background doc send (fire-and-forget)
        (async () => {
          try {
            const r = await sendDocumentRobust(from, TV_MEDIA_ID);
            console.log("Background: TV document sent:", r?.status);
          } catch (errDoc) {
            logAxiosError("Background TV document send failed", errDoc);
          }
        })();

        return; // we're done after acking
      }

      if (normalizedId === (AC_BUTTON_ID || "ac").toLowerCase()) {
        try {
          await sendText(from, AC_LINK);
        } catch (errText) {
          logAxiosError("sendText (ac) failed", errText);
        }

        res.status(200).send("accepted-ac");

        (async () => {
          try {
            const r = await sendDocumentRobust(from, AC_MEDIA_ID);
            console.log("Background: AC document sent:", r?.status);
          } catch (errDoc) {
            logAxiosError("Background AC document send failed", errDoc);
          }
        })();

        return;
      }

      // unknown button id -> immediate feedback and ack
      try {
        await sendText(from, "Sorry, I didn't recognize that option. Please try again.");
      } catch (errText) {
        logAxiosError("sendText (unknown button) failed", errText);
      }
      return res.status(200).send("unknown-button");
    }

    // typed fallback
    const typed = (incoming.text || "").trim().toLowerCase();
    if (typed === TV_BUTTON_TITLE.toLowerCase() || typed === "tv") {
      try {
        await sendText(from, TV_LINK);
      } catch (errText) {
        logAxiosError("sendText (tv typed) failed", errText);
      }
      // ack quickly then background doc send
      res.status(200).send("accepted-tv-typed");
      (async () => {
        try {
          await sendDocumentRobust(from, TV_MEDIA_ID);
          console.log("Background: TV typed doc sent");
        } catch (errDoc) {
          logAxiosError("Background TV typed send failed", errDoc);
        }
      })();
      return;
    }

    if (typed === AC_BUTTON_TITLE.toLowerCase() || typed === "ac") {
      try {
        await sendText(from, AC_LINK);
      } catch (errText) {
        logAxiosError("sendText (ac typed) failed", errText);
      }
      res.status(200).send("accepted-ac-typed");
      (async () => {
        try {
          await sendDocumentRobust(from, AC_MEDIA_ID);
          console.log("Background: AC typed doc sent");
        } catch (errDoc) {
          logAxiosError("Background AC typed send failed", errDoc);
        }
      })();
      return;
    }

    // otherwise: initial user message => intro + interactive buttons (await interactive; then respond normally)
    try {
      // send intro (best-effort)
      await sendText(from, INTRO_TEXT);
    } catch (errIntro) {
      logAxiosError("Intro text failed", errIntro);
      // continue to interactive attempt
    }

    try {
      await sendInteractiveButtons(from);
      console.log("Interactive buttons sent to", from);
      return res.status(200).send("interactive-sent");
    } catch (errInteractive) {
      logAxiosError("Interactive send failed", errInteractive);
      return res.status(502).send("interactive-send-failed");
    }
  } catch (err) {
    console.error("Unhandled webhook error:", err);
    return res.status(500).send("internal-error");
  }
});

/* --------- START --------- */
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
