// server.js - Whapi.Cloud minimal, authoritative shapes (text then document)

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
const MEDIA_ID = process.env.MEDIA_ID || null;
const SEND_TEXT_URL = process.env.SEND_TEXT_URL || "https://gate.whapi.cloud/messages/text";
const SEND_DOC_URL = process.env.SEND_URL || "https://gate.whapi.cloud/messages/document";
const PDF_FILENAME = process.env.PDF_FILENAME || "document.pdf";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || null;

const DEDUPE_TTL_MIN = parseInt(process.env.DEDUPE_TTL_MIN || "5", 10);
const DEDUPE_TTL_MS = DEDUPE_TTL_MIN * 60 * 1000;
const MAX_DEDUPE_ENTRIES = parseInt(process.env.MAX_DEDUPE_ENTRIES || "10000", 10);
const SEND_TIMEOUT_MS = parseInt(process.env.SEND_TIMEOUT_MS || "10000", 10);

if (!SEND_API_KEY) {
  console.error("Missing required env var: SEND_API_KEY");
  process.exit(1);
}

const dedupe = new LRU({ max: MAX_DEDUPE_ENTRIES, ttl: DEDUPE_TTL_MS });

app.get("/health", (req, res) => {
  res.json({ status: "ok", media_id_present: !!MEDIA_ID });
});

/** Robust extractor for common webhook shapes. Returns { messageId, from, raw } */
function extractIncoming(body) {
  if (!body) return { messageId: null, from: null, raw: body };

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const m = body.messages[0];
    return { messageId: m.id || m.msg_id || m.message_id || null, from: m.from || m.sender || m.chat_id || null, raw: m };
  }
  if (Array.isArray(body.data) && body.data.length > 0) {
    const d = body.data[0];
    return { messageId: d.id || d.message_id || null, from: d.from || d.sender || d?.message?.from || d?.phone || null, raw: d };
  }
  if (Array.isArray(body.entry) && body.entry.length > 0) {
    try {
      const change = body.entry[0].changes?.[0];
      const val = change?.value || body.entry[0];
      const msg = (val.messages && val.messages[0]) || val.message || val;
      return { messageId: msg?.id || msg?.message_id || null, from: msg?.from || msg?.sender || val?.phone || null, raw: msg };
    } catch (e) {
      // fall through
    }
  }
  return { messageId: body.id || body.message_id || Date.now().toString(), from: body.from || body.sender || body.phone || null, raw: body };
}

/** Send text using Whapi docs: { to, body } */
async function sendText(toPhone, text) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, "Content-Type": "application/json" };
  const payload = { to: String(toPhone), body: String(text) };
  return axios.post(SEND_TEXT_URL, payload, { headers, timeout: SEND_TIMEOUT_MS });
}

/** Send document using Whapi docs: { to, media, filename, type: 'document' } */
async function sendDocument(toPhone, mediaId) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, "Content-Type": "application/json" };
  const payload = { to: String(toPhone), media: String(mediaId), filename: PDF_FILENAME, type: "document" };
  return axios.post(SEND_DOC_URL, payload, { headers, timeout: SEND_TIMEOUT_MS });
}

app.post("/webhook", async (req, res) => {
  try {
    // Optional token verification header (set VERIFY_TOKEN in Railway if used)
    if (VERIFY_TOKEN) {
      const token = req.headers["x-whapi-token"] || req.headers["x-webhook-token"] || req.headers["x-hub-signature"] || null;
      if (token !== VERIFY_TOKEN) {
        console.warn("Webhook verification failed - token mismatch");
        return res.status(401).send("invalid token");
      }
    }

    const incoming = extractIncoming(req.body);
    let messageId = incoming.messageId || Date.now().toString();
    let from = incoming.from || null;

    // normalize from if it's a JID like 9190...@s.whatsapp.net
    if (typeof from === "string" && from.includes("@")) {
      from = from.split("@")[0];
    }

    if (!from) {
      console.warn("Could not extract sender phone; raw payload:", JSON.stringify(incoming.raw || req.body));
      return res.status(400).send("missing-sender");
    }

    // Deduplicate
    if (dedupe.get(messageId)) {
      console.log("Duplicate webhook ignored:", messageId);
      return res.status(200).send("ok");
    }
    dedupe.set(messageId, true);

    // Step 1: quick text ack
    const quickText = process.env.QUICK_TEXT || "Thanks for reaching us - sending the document now.";
    try {
      const textResp = await sendText(from, quickText);
      console.log("Quick text sent:", textResp.status, textResp.data ? JSON.stringify(textResp.data).slice(0,200) : "");
    } catch (err) {
      console.error("Quick text send failed:", err?.response?.status, err?.response?.data || err?.message);
      // return 502 so webhook sender (Whapi) may retry; if you prefer to ack anyway, change to 200
      return res.status(502).send("text-send-failed");
    }

    // Step 2: document send (only if media configured)
    if (!MEDIA_ID) {
      console.warn("MEDIA_ID not set; skipping document send");
      return res.status(200).send("text-sent-no-media");
    }

    try {
      const docResp = await sendDocument(from, MEDIA_ID);
      console.log("Document sent (JSON):", docResp.status, docResp.data ? JSON.stringify(docResp.data).slice(0,200) : "");
      return res.status(200).send("text-and-document-sent");
    } catch (err) {
      // Log provider response for debugging
      console.warn("Document JSON send failed:", err?.response?.status, err?.response?.data || err?.message);
      // If media-not-found or other, surface as 502 to allow retry
      return res.status(502).send("document-send-failed");
    }

  } catch (err) {
    console.error("Unhandled webhook error:", err);
    return res.status(500).send("internal-error");
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT} - MEDIA_ID present: ${!!MEDIA_ID}`);
});
