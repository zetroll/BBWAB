/**
 * server.js - Interactive two-button flow (TV / AC) for Whapi.Cloud
 *
 * Flow:
 * 1) On inbound message, send INTRO_TEXT as text ACK.
 * 2) Send an interactive message with two quick-reply buttons (TV, AC).
 * 3) When user chooses button (or replies with text), send corresponding LINK and PDF.
 *
 * Env vars (Railway):
 * - SEND_API_KEY (required)
 * - SEND_TEXT_URL (default https://gate.whapi.cloud/messages/text)
 * - SEND_DOC_URL  (default https://gate.whapi.cloud/messages/document)
 * - SEND_INTERACTIVE_URL (default https://gate.whapi.cloud/messages/interactive)
 * - INTRO_TEXT (required) - text to show before buttons
 * - TV_BUTTON_TITLE (default TV)
 * - TV_LINK (required) - url
 * - TV_MEDIA_ID (required)
 * - AC_BUTTON_TITLE (default AC)
 * - AC_LINK (required)
 * - AC_MEDIA_ID (required)
 * - VERIFY_TOKEN (optional)
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

/* helpers */
function extractCommon(body) {
  // return { messageId, from, text, raw }
  if (!body) return { messageId: null, from: null, text: null, raw: body };

  // Whapi sometimes wraps messages in `messages` array (observed)
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const m = body.messages[0];
    const text = m?.text?.body || m?.message?.text?.body || m?.body || null;
    return {
      messageId: m.id || m.msg_id || m.message_id || null,
      from: (m.from || m.sender || m.chat_id || m?.from_name || null),
      text,
      raw: m
    };
  }

  // WhatsApp Cloud style wrapper (some providers)
  if (body?.whatsappInboundMessage) {
    const w = body.whatsappInboundMessage;
    const text = w?.text?.body || w?.message?.text?.body || null;
    return {
      messageId: w?.id || null,
      from: w?.from || null,
      text,
      raw: w
    };
  }

  // fallback: top-level fields
  return {
    messageId: body.id || body.message_id || Date.now().toString(),
    from: body.from || body.sender || body.phone || null,
    text: body?.text?.body || body?.body || null,
    raw: body
  };
}

async function sendText(toPhone, body) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, "Content-Type": "application/json" };
  const payload = { to: String(toPhone), body: String(body) };
  return axios.post(SEND_TEXT_URL, payload, { headers, timeout: SEND_TIMEOUT_MS });
}

async function sendDocument(toPhone, mediaId) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, "Content-Type": "application/json" };
  const payload = { to: String(toPhone), media: String(mediaId), filename: PDF_FILENAME, type: "document" };
  return axios.post(SEND_DOC_URL, payload, { headers, timeout: SEND_TIMEOUT_MS });
}

async function sendInteractiveButtons(toPhone) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, "Content-Type": "application/json" };

  // Per Whapi/WhatsApp interactive/button schema: type 'interactive', action.buttons -> reply buttons
  const payload = {
    to: String(toPhone),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: INTRO_TEXT },
      action: {
        buttons: [
          { type: "reply", reply: { id: "tv", title: TV_BUTTON_TITLE } },
          { type: "reply", reply: { id: "ac", title: AC_BUTTON_TITLE } }
        ]
      }
    }
  };

  return axios.post(SEND_INTERACTIVE_URL, payload, { headers, timeout: SEND_TIMEOUT_MS });
}

/* detect interactive button reply in many possible webhook shapes */
function extractButtonReply(body) {
  // common patterns:
  // - body.interactive.button_reply.id
  // - body.messages[0].interactive.button_reply.id
  // - body.whatsappInboundMessage.interactive.button_reply.id
  const raw = body || {};
  const candidates = [
    raw.interactive?.button_reply,
    raw.messages?.[0]?.interactive?.button_reply,
    raw.whatsappInboundMessage?.interactive?.button_reply,
    raw.whatsappInboundMessage?.interactive?.button_reply,
    raw.interactive?.button_reply
  ];
  for (const c of candidates) {
    if (c && (c.id || c.title)) return { id: c.id || null, title: c.title || null };
  }

  // some providers put reply under 'reply' or 'message.reply'
  const alt = raw.messages?.[0]?.reply || raw.reply || raw.messages?.[0]?.message?.reply;
  if (alt && (alt.id || alt.title)) return { id: alt.id || null, title: alt.title || null };

  return null;
}

/* Webhook: show intro + interactive buttons. When user chooses, send link + pdf */
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
    let messageId = incoming.messageId || Date.now().toString();
    let from = incoming.from;
    if (!from) {
      console.warn("no 'from' in incoming payload:", JSON.stringify(incoming.raw || req.body).slice(0,400));
      return res.status(400).send("missing-sender");
    }
    // normalize jid -> phone
    if (typeof from === "string" && from.includes("@")) from = from.split("@")[0];

    // dedupe
    if (dedupe.get(messageId)) {
      console.log("duplicate webhook ignored", messageId);
      return res.status(200).send("ok");
    }
    dedupe.set(messageId, true);

    // If the inbound is an interactive reply (button press), handle selection
    const button = extractButtonReply(req.body);
    if (button && button.id) {
      console.log("Detected button reply:", button);
      const id = String(button.id).toLowerCase();
      if (id === "tv" || id === process.env.TV_BUTTON_ID?.toLowerCase()) {
        // send TV link + pdf
        try {
          await sendText(from, TV_LINK);
          await sendDocument(from, TV_MEDIA_ID);
          console.log("Sent TV link & PDF to", from);
          return res.status(200).send("tv-sent");
        } catch (err) {
          console.error("Failed to send TV assets:", err?.response?.status, err?.response?.data || err.message);
          return res.status(502).send("tv-send-failed");
        }
      }
      if (id === "ac" || id === process.env.AC_BUTTON_ID?.toLowerCase()) {
        try {
          await sendText(from, AC_LINK);
          await sendDocument(from, AC_MEDIA_ID);
          console.log("Sent AC link & PDF to", from);
          return res.status(200).send("ac-sent");
        } catch (err) {
          console.error("Failed to send AC assets:", err?.response?.status, err?.response?.data || err.message);
          return res.status(502).send("ac-send-failed");
        }
      }
      // unknown id -> reply with clarifying text
      await sendText(from, "Sorry, I didn't recognize that option. Please try again.");
      return res.status(200).send("unknown-button");
    }

    // If incoming is plain text equal to TV/AC, handle that too (user may type)
    const replyText = (incoming.text || "").trim().toLowerCase();
    if (replyText === (TV_BUTTON_TITLE || "tv").toLowerCase() || replyText === "tv") {
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
    if (replyText === (AC_BUTTON_TITLE || "ac").toLowerCase() || replyText === "ac") {
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

    // Otherwise: fresh incoming user message — send intro text + interactive buttons
    try {
      // Step A: intro text (simple ack)
      await sendText(from, INTRO_TEXT);
    } catch (err) {
      console.warn("Intro text failed:", err?.response?.status, err?.response?.data || err.message);
      // continue — still try to send interactive
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
