/**
 * server.js - Whapi.Cloud adjusted to use 'media' as a string (drop-in replacement)
 *
 * Key change vs previous:
 * - Primary attempt uses JSON payload with `media` (string) which matches Whapi error hints.
 * - Multipart fallback uses form field `media` (string).
 *
 * Env vars:
 * - SEND_URL (optional, default to Whapi document endpoint)
 * - SEND_API_KEY (required)
 * - MEDIA_ID (required)
 * - VERIFY_TOKEN (optional)
 * - PDF_FILENAME (optional)
 */

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const LRU = require('lru-cache');
const morgan = require('morgan');
const FormData = require('form-data');

const app = express();
app.use(bodyParser.json({ limit: '500kb' }));
app.use(morgan('combined'));

const PORT = process.env.PORT || 8080;
let MEDIA_ID = process.env.MEDIA_ID || null;
const SEND_URL = process.env.SEND_URL || 'https://gate.whapi.cloud/messages/document';
const SEND_API_KEY = process.env.SEND_API_KEY;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || null;
const PDF_FILENAME = process.env.PDF_FILENAME || 'document.pdf';
const DEDUPE_TTL_MS = parseInt(process.env.DEDUPE_TTL_MIN || '5') * 60 * 1000;
const MAX_DEDUPE_ENTRIES = parseInt(process.env.MAX_DEDUPE_ENTRIES || '10000');
const SEND_TIMEOUT_MS = parseInt(process.env.SEND_TIMEOUT_MS || '10000');

if (!SEND_API_KEY) {
  console.error('Missing required env var: SEND_API_KEY. Aborting.');
  process.exit(1);
}

const dedupe = new LRU({ max: MAX_DEDUPE_ENTRIES, ttl: DEDUPE_TTL_MS });

app.get('/health', (req, res) => {
  res.json({ status: 'ok', media_id_present: !!MEDIA_ID });
});

// robust incoming extraction similar to before
function extractIncoming(body) {
  if (!body) return { messageId: null, from: null, raw: body };

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const m = body.messages[0];
    return {
      messageId: m.id || m.msg_id || m.message_id || null,
      from: m.from || m.sender || m.chat_id || null,
      raw: m
    };
  }

  if (Array.isArray(body.data) && body.data.length > 0) {
    const d = body.data[0];
    return {
      messageId: d.id || d.message_id || d.msg_id || null,
      from: d.from || d.sender || d?.message?.from || d?.phone || null,
      raw: d
    };
  }

  if (Array.isArray(body.entry) && body.entry.length > 0) {
    try {
      const change = body.entry[0].changes?.[0];
      const val = change?.value || body.entry[0];
      const msg = (val.messages && val.messages[0]) || val.message || val;
      return {
        messageId: msg?.id || msg?.message_id || msg?.msg_id || null,
        from: msg?.from || msg?.sender || val?.phone || null,
        raw: msg
      };
    } catch (e) {}
  }

  return {
    messageId: body.id || body.message_id || body.msg_id || (new Date().getTime().toString()),
    from: body.from || body.sender || body.phone || null,
    raw: body
  };
}

/**
 * Primary send: JSON with `media` as a string (the media id)
 * Fallback: multipart with field `media` as a string
 */
async function sendDocumentWhapi(toPhone, mediaId) {
  const baseHeaders = { 'Authorization': `Bearer ${SEND_API_KEY}` };

  // Attempt 1: JSON with media as string
  try {
    const payload = {
      to: toPhone,
      media: String(mediaId),
      filename: PDF_FILENAME,
      type: 'document'
    };
    console.log('Attempting J
