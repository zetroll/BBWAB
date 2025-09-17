/**
 * server.js - Interactive buttons (fixed): sanitize 'to', correct interactive payload, ignore statuses/from_me
 *
 * Replace your current server.js with this file and redeploy.
 */

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const LRU = require("lru-cache");
const morgan = require("morgan");

const app = express();
app.use(bodyParser.json({ limit: "500kb" }));
app.use(morgan("combined"));

const PORT = process.env.PORT || 8080;
const SEND_API_KEY = process.env.SEND_API_KEY;
const SEND_TEXT_URL = process.env.SEND_TEXT_URL || "https://gate.whapi.cloud/messages/text";
const SEND_DOC_URL = process.env.SEND_DOC_URL || "https://gate.whapi.cloud/messages/document";
const SEND_INTERACTIVE_URL = process.env.SEND_INTERACTIVE_URL || "https://gate.whapi.cloud/messages/interactive";

const INTRO_TEXT = process.env.INTRO_TEXT || "Thanks for reaching us - choose one option below:";
const TV_BUTTON_TITLE = process.env.TV_BUTTON_TITLE || "TV";
const TV_LINK = process.env.TV_LINK || "";
const TV_MEDIA_ID = process.env.TV_MEDIA_ID || "";
const AC_BUTTON_TITLE = process.env.AC_BUTTON_TITLE || "AC";
const AC_LINK = process.env.AC_LINK || "";
const AC_MEDIA_ID = process.env.AC_MEDIA_ID || "";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || null;
const SENDER_PHONE = process.env.SENDER_PHONE || null; // optional: your own number to ignore echoes
const PDF_FILENAME = process.env.PDF_FILENAME || "document.pdf";

const DEDUPE_TTL_MIN = parseInt(process.env.DEDUPE_TTL_MIN || "5", 10);
const DEDUPE_TTL_MS = DEDUPE_TTL_MIN * 60 * 1000;
const MAX_DEDUPE_ENTRIES = parseInt(process.env.MAX_DEDUPE_ENTRIES || "10000", 10);
const SEND_TIMEOUT_MS = parseInt(process.env.SEND_TIMEOUT_MS || "10000", 10);

if (!SEND_API_KEY) {
  console.error("Missing SEND_API_KEY. Aborting.");
  process.exit(1);
}
if (!INTRO_TEXT) {
  console.error("Missing INTRO_TEXT. Aborting.");
  process.exit(1);
}
if (!TV_LINK || !TV_MEDIA_ID || !AC_LINK || !AC_MEDIA_ID) {
  console.error("Missing one of TV/AC link or media env vars. Aborting.");
  process.exit(1);
}

const dedupe = new LRU({ max: MAX_DEDUPE_ENTRIES, ttl: DEDUPE_TTL_MS });

app.get("/health", (req, res) => res.json({ status: "ok" }));

/* Normalize phone/JID to acceptable 'to' form:
   - If includes '@', keep domain but strip non-digits from user part.
   - Else, strip non-digits.
   Returns string or null if invalid.
*/
function normalizePhone(raw) {
  if (!raw || typeof raw !== "string") return null;
  raw = raw.trim();
  if (raw.includes("@")) {
    const parts = raw.split("@");
    let user = parts[0].replace(/\D+/g, ""); // keep digits only
    const domain = parts.slice(1).join("@");
    if (!user) return null;
    return `${user}@${domain}`;
  } else {
    // remove any non-digit characters (spaces, plus, parens, dashes)
    const digits = raw.replace(/\D+/g, "");
    return digits.length >= 9 ? digits : null;
  }
}

/* Extract common incoming shapes and also detect statuses vs messages */
function extractCommon(body) {
  if (!body) return { kind: "unknown", raw: body };

  // statuses (delivery/read) - ignore
  if (Array.isArray(body.statuses) && body.statuses.length > 0) {
    return { kind: "status", statuses: body.statuses, raw: body };
  }

  // messages array (common Whapi shape)
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const m = body.messages[0];
    return {
      kind: "message",
      messageId: m.id || m.msg_id || m.message_id || null,
      from: m.from || m.sender || m.chat_id || null,
      from_me: !!m.from_me,
      text: m?.text?.body || m?.body || m?.message?.text?.body || null,
      raw: m
    };
  }

  // some providers use top-level 'messages' differently, check for direct 'message' wrapper
  if (body.message) {
    const m = body.message;
    return {
      kind: "message",
      messageId: m.id || null,
      from: m.from || m.sender || null,
      from_me: !!m.from_me,
      text: m?.text?.body || m?.body || null,
      raw: m
    };
  }

  // fallback: unknown
  return { kind: "unknown", raw: body };
}

/* Send helpers using Whapi documented shapes */
async function sendText(toPhone, bodyText) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, "Content-Type": "application/json" };
  const payload = { to: String(toPhone), body: String(bodyText) };
  return axios.post(SEND_TEXT_URL, payload, { headers, timeout: SEND_TIMEOUT_MS });
}

async function sendDocument(toPhone, mediaId) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, "Content-Type": "application/json" };
  const payload = { to: String(toPhone), media: String(mediaId), filename: PDF_FILENAME, type: "document" };
  return axios.post(SEND_DOC_URL, payload, { headers, timeout: SEND_TIMEOUT_MS });
}

async function sendInteractiveButtons(toPhone) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, "Content-Type": "application/json" };

  // Per Whapi docs: top-level body, top-level action, type, to
  const payload = {
    body: { text: INTRO_TEXT },
    action: {
      buttons: [
        { type: "quick_reply", title: TV_BUTTON_TITLE, id: "tv" },
        { type: "quick_reply", title: AC_BUTTON_TITLE, id: "ac" }
      ]
    },
    type: "button",
    to: String(toPhone)
  };

  return axios.post(SEND_INTERACTIVE_URL, payload, { headers, timeout: SEND_TIMEOUT_MS });
}

/* Extract button reply from webhook shapes (support various callbacks) */
function extractButtonReply(body) {
  if (!body) return null;

  // Known shape: messages[0].reply.buttons_reply (support older "buttons_reply") or reply/buttons_reply
  try {
    const m = (body.messages && body.messages[0]) || body.message || body;
    // support Whapi helpdesk examples: reply.buttons_reply.id or reply.type === 'buttons_reply'
    if (m?.reply?.buttons_reply) {
      return { id: m.reply.buttons_reply.id, title: m.reply.buttons_reply.title };
    }
    // old example: reply.type == 'buttons_reply' && reply.buttons_reply.{id,title}
    if (m?.reply?.type === "buttons_reply" && m?.reply?.buttons_reply) {
      return { id: m.reply.buttons_reply.id, title: m.reply.buttons_reply.title };
    }
    // another example from docs: messages[0].reply.type === 'buttons_reply' and reply.buttons_reply present
    if (m?.reply?.type === "buttons_reply" && m?.reply?.buttons_reply) {
      return { id: m.reply.buttons_reply.id, title: m.reply.buttons_reply.title };
    }

    // WhatsApp Cloud-like: messages[0].interactive.button_reply
    if (m?.interactive?.button_reply) {
      return { id: m.interactive.button_reply.id, title: m.interactive.button_reply.title };
    }

    // fallback: messages[0].reply?.buttons_reply
    const br = m?.reply?.buttons_reply || m?.reply?.buttons_reply;
    if (br && (br.id || br.title)) return { id: br.id || null, title: br.title || null };

  } catch (e) {
    // ignore
  }
  return null;
}

/* Main webhook handler */
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

    // ignore statuses (delivery/read) events
    if (incoming.kind === "status" || incoming.kind === "statuses") {
      console.log("Received statuses event - ignoring");
      return res.status(200).send("ignored-status");
    }

    if (incoming.kind !== "message") {
      console.log("Unknown webhook kind - ignoring", JSON.stringify(incoming.raw).slice(0,300));
      return res.status(200).send("ignored");
    }

    // ignore if this is an echo of our own sent message
    if (incoming.from_me) {
      console.log("Ignoring from_me echo");
      return res.status(200).send("ignored-from-me");
    }

    let messageId = incoming.messageId || Date.now().toString();
    let rawFrom = incoming.from;
    let from = normalizePhone(rawFrom);

    // If SENDER_PHONE is configured, ignore messages that come from that phone (your own)
    if (SENDER_PHONE) {
      const normSender = normalizePhone(SENDER_PHONE);
      if (normSender && from === normSender) {
        console.log("Ignoring message from configured sender phone (self)");
        return res.status(200).send("ignored-self");
      }
    }

    if (!from) {
      console.warn("no 'from' in incoming payload or invalid format:", JSON.stringify(incoming.raw || req.body).slice(0,400));
      return res.status(400).send("missing-sender");
    }

    // dedupe
    if (dedupe.get(messageId)) {
      console.log("Duplicate webhook ignored", messageId);
      return res.status(200).send("ok");
    }
    dedupe.set(messageId, true);

    // If user clicked a button, handle it
    const buttonReply = extractButtonReply(req.body);
    if (buttonReply && buttonReply.id) {
      const id = String(buttonReply.id).toLowerCase();
      console.log("Button reply detected:", id, buttonReply.title);

      if (id === "tv" || id === (process.env.TV_BUTTON_ID || "tv").toLowerCase()) {
        try {
          await sendText(from, TV_LINK);
          await sendDocument(from, TV_MEDIA_ID);
          console.log("Sent TV link + PDF to", from);
          return res.status(200).send("tv-sent");
        } catch (err) {
          console.error("Failed to send TV assets:", err?.response?.status, err?.response?.data || err.message);
          return res.status(502).send("tv-send-failed");
        }
      }

      if (id === "ac" || id === (process.env.AC_BUTTON_ID || "ac").toLowerCase()) {
        try {
          await sendText(from, AC_LINK);
          await sendDocument(from, AC_MEDIA_ID);
          console.log("Sent AC link + PDF to", from);
          return res.status(200).send("ac-sent");
        } catch (err) {
          console.error("Failed to send AC assets:", err?.response?.status, err?.response?.data || err.message);
          return res.status(502).send("ac-send-failed");
        }
      }

      // unknown button id
      await sendText(from, "Sorry, I didn't recognize that option. Please try again.");
      return res.status(200).send("unknown-button");
    }

    // If user typed plain text matching button titles, handle that as fallback
    const typed = (incoming.text || "").trim().toLowerCase();
    if (typed === TV_BUTTON_TITLE.toLowerCase() || typed === "tv") {
      try {
        await sendText(from, TV_LINK);
        await sendDocument(from, TV_MEDIA_ID);
        console.log("Sent TV assets (typed) to", from);
        return res.status(200).send("tv-sent-typed");
      } catch (err) {
        console.error("Failed TV typed send:", err?.response?.data || err.message);
        return res.status(502).send("tv-send-failed");
      }
    }
    if (typed === AC_BUTTON_TITLE.toLowerCase() || typed === "ac") {
      try {
        await sendText(from, AC_LINK);
        await sendDocument(from, AC_MEDIA_ID);
        console.log("Sent AC assets (typed) to", from);
        return res.status(200).send("ac-sent-typed");
      } catch (err) {
        console.error("Failed AC typed send:", err?.response?.data || err.message);
        return res.status(502).send("ac-send-failed");
      }
    }

    // Otherwise: fresh incoming user message — send intro + interactive
    try {
      await sendText(from, INTRO_TEXT);
    } catch (err) {
      console.warn("Intro text failed:", err?.response?.status, err?.response?.data || err.message);
      // continue to attempt interactive
    }

    try {
      await sendInteractiveButtons(from);
      console.log("Interactive buttons sent to", from);
      return res.status(200).send("interactive-sent");
    } catch (err) {
      console.error("Interactive send failed:", err?.response?.status, err?.response?.data || err.message);
      return res.status(502).send("interactive-send-failed");
    }

  } catch (err) {
    console.error("Unhandled error in webhook handler:", err);
    return res.status(500).send("internal-error");
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
