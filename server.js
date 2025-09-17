/**
 * server.js - Interactive flow fixes:
 * - Normalize button reply IDs like "buttonsv3:tv" -> "tv"
 * - Separate INTERACTIVE_BODY to avoid duplicate intro text
 * - Allow configurable TV_BUTTON_ID / AC_BUTTON_ID overrides
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

// content env vars (configurable)
const INTRO_TEXT = process.env.INTRO_TEXT || "Hi, I'm Dileep, and I want to share my favourite products with you!"; // short intro
const INTERACTIVE_BODY = process.env.INTERACTIVE_BODY || "Choose which category you are interested in:";    // separate body for buttons
const TV_BUTTON_TITLE = process.env.TV_BUTTON_TITLE || "TV";
const TV_BUTTON_ID = process.env.TV_BUTTON_ID || "tv";   // set to vendor-specific id if desired
const TV_LINK = process.env.TV_LINK || "";
const TV_MEDIA_ID = process.env.TV_MEDIA_ID || "";
const AC_BUTTON_TITLE = process.env.AC_BUTTON_TITLE || "AC";
const AC_BUTTON_ID = process.env.AC_BUTTON_ID || "ac";
const AC_LINK = process.env.AC_LINK || "";
const AC_MEDIA_ID = process.env.AC_MEDIA_ID || "";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || null;
const SENDER_PHONE = process.env.SENDER_PHONE || null; // optional: ignore messages from this number
const PDF_FILENAME = process.env.PDF_FILENAME || "document.pdf";

const DEDUPE_TTL_MIN = parseInt(process.env.DEDUPE_TTL_MIN || "5", 10);
const DEDUPE_TTL_MS = DEDUPE_TTL_MIN * 60 * 1000;
const MAX_DEDUPE_ENTRIES = parseInt(process.env.MAX_DEDUPE_ENTRIES || "10000", 10);
const SEND_TIMEOUT_MS = parseInt(process.env.SEND_TIMEOUT_MS || "10000", 10);

if (!SEND_API_KEY) {
  console.error("Missing SEND_API_KEY. Aborting.");
  process.exit(1);
}
if (!TV_LINK || !TV_MEDIA_ID || !AC_LINK || !AC_MEDIA_ID) {
  console.error("Missing one of TV/AC link or media env vars. Aborting.");
  process.exit(1);
}

const dedupe = new LRU({ max: MAX_DEDUPE_ENTRIES, ttl: DEDUPE_TTL_MS });

app.get("/health", (req, res) => res.json({ status: "ok" }));

/* Normalize phone/JID to acceptable 'to' form */
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

/* Extract incoming message or status */
function extractCommon(body) {
  if (!body) return { kind: "unknown", raw: body };
  if (Array.isArray(body.statuses) && body.statuses.length > 0) {
    return { kind: "status", statuses: body.statuses, raw: body };
  }
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
    return {
      kind: "message",
      messageId: m.id || null,
      from: m.from || m.sender || null,
      from_me: !!m.from_me,
      text: m?.text?.body || m?.body || null,
      raw: m
    };
  }
  return { kind: "unknown", raw: body };
}

/* Send helpers */
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

/* Send interactive buttons; note: body is INTERACTIVE_BODY */
async function sendInteractiveButtons(toPhone) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, "Content-Type": "application/json" };

  // Use the Whapi interactive/button shape expected by the gateway
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

  return axios.post(SEND_INTERACTIVE_URL, payload, { headers, timeout: SEND_TIMEOUT_MS });
}

/* Extract button reply robustly */
function extractButtonReply(body) {
  if (!body) return null;
  // common paths
  const m = (body.messages && body.messages[0]) || body.message || body;
  // WhatsApp Cloud: m.interactive.button_reply
  if (m?.interactive?.button_reply) {
    return { id: m.interactive.button_reply.id, title: m.interactive.button_reply.title };
  }
  // Whapi older shapes: m.reply.buttons_reply or reply.buttons_reply
  if (m?.reply?.buttons_reply) return { id: m.reply.buttons_reply.id, title: m.reply.buttons_reply.title };
  // generic fallback: reply object with id/title
  if (m?.reply && (m.reply.id || m.reply.title)) return { id: m.reply.id || null, title: m.reply.title || null };
  return null;
}

/* Normalize button id like "buttonsv3:tv" -> "tv" */
function normalizeButtonId(rawId) {
  if (!rawId) return null;
  // if contains colon, take last segment
  const parts = String(rawId).split(":");
  return parts[parts.length - 1].toLowerCase();
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

    // ignore statuses
    if (incoming.kind === "status" || incoming.kind === "statuses") {
      console.log("Received statuses event - ignoring");
      return res.status(200).send("ignored-status");
    }

    if (incoming.kind !== "message") {
      console.log("Unknown webhook kind - ignoring");
      return res.status(200).send("ignored");
    }

    // ignore echoes
    if (incoming.from_me) {
      console.log("Ignoring from_me echo");
      return res.status(200).send("ignored-from-me");
    }

    let messageId = incoming.messageId || Date.now().toString();
    const rawFrom = incoming.from;
    const from = normalizePhone(rawFrom);

    // ignore if sender phone equals configured sender (self)
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

    // handle button reply
    const btn = extractButtonReply(req.body);
    if (btn && btn.id) {
      const normalizedId = normalizeButtonId(btn.id);
      console.log("Button reply detected:", btn.id, btn.title, "-> normalized:", normalizedId);

      if (normalizedId === (TV_BUTTON_ID || "tv").toLowerCase()) {
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

      if (normalizedId === (AC_BUTTON_ID || "ac").toLowerCase()) {
        try {
          await sendText(from, AC_LINK);
          await sendDocument(from, AC_MEDIA_ID);
          console.log("Sent AC link + PDF to", from);
          return res.status(200).send("ac-sent");
        } catch (err
