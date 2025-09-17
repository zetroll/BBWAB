/**
 * server.js - Whapi.Cloud authoritative shapes:
 *  - Text:   { to: "...", body: "..." } -> POST /messages/text
 *  - Document: { to: "...", media: "<MEDIA_ID>", filename: "...", type: "document" } -> POST /messages/document
 *
 * Replace your server.js with this and redeploy.
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
const SEND_TEXT_URL = process.env.SEND_TEXT_URL || 'https://gate.whapi.cloud/messages/text';
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

/* Robust incoming parser */
function extractIncoming(body) {
  if (!body) return { messageId: null, from: null, raw: body };

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const m = body.messages[0];
    return { messageId: m.id || m.msg_id || null, from: m.from || m.sender || m.chat_id || null, raw: m };
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
      return { messageId: msg?.id || null, from: msg?.from || msg?.sender || val?.phone || null, raw: msg };
    } catch (e) {}
  }
  return { messageId: body.id || body.message_id || (new Date().getTime().toString()), from: body.from || body.sender || body.phone || null, raw: body };
}

/* Send text using authoritative Whapi shape: { to, body } */
async function sendTextWhapi(toPhone, text) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, 'Content-Type': 'application/json' };
  const payload = { to: String(toPhone), body: String(text) };
  return axios.post(SEND_TEXT_URL, payload, { headers, timeout: SEND_TIMEOUT_MS });
}

/* Send document using 'media' string as required by Whapi */
async function sendDocumentWhapi(toPhone, mediaId) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, 'Content-Type': 'application/json' };
  const payload = {
    to: String(toPhone),
    media: String(mediaId),    // <-- per Whapi docs: media is a string media-id
    filename: PDF_FILENAME,
    type: 'document'
  };
  return axios.post(SEND_URL, payload, { headers, timeout: SEND_TIMEOUT_MS });
}

/* Multipart fallback (only if JSON returns media-not-found or other issues) */
async function sendDocumentMultipartWhapi(toPhone, mediaId) {
  const headersBase = { Authorization: `Bearer ${SEND_API_KEY}` };
  const form = new FormData();
  form.append('to', String(toPhone));
  form.append('media', String(mediaId));
  form.append('filename', PDF_FILENAME);
  form.append('type', 'document');
  return axios.post(SEND_URL, form, { headers: { ...headersBase, ...form.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity, timeout: Math.max(SEND_TIMEOUT_MS, 20000) });
}

/* Webhook handler: quick text then document */
app.post('/webhook', async (req, res) => {
  try {
    if (VERIFY_TOKEN) {
      const token = req.headers['x-whapi-token'] || req.headers['x-webhook-token'] || null;
      if (token !== VERIFY_TOKEN) {
        console.warn('Webhook verification failed - token mismatch');
        return res.status(401).send('invalid token');
      }
    }

    const incoming = extractIncoming(req.body);
    const messageId
