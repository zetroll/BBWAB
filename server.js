/**
 * server.js - Whapi.Cloud robust webhook server (drop-in replacement)
 *
 * Improvements vs previous:
 * - Handles incoming webhook shapes that include `messages[]` (your sample).
 * - Tries multiple Whapi send payload shapes (JSON + multipart variations) until one works.
 * - Better debug logs showing attempted payload shapes and provider responses.
 *
 * Env vars:
 * - SEND_URL (optional) default: https://gate.whapi.cloud/messages/document
 * - SEND_API_KEY (required)
 * - MEDIA_ID (required)
 * - VERIFY_TOKEN (optional)
 * - PDF_FILENAME (optional)
 * - Other tuning env vars present as before.
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

/**
 * Extract incoming message id and sender phone robustly from many shapes.
 * Your sample had: { messages: [ { id, from, ... } ], event: {...}, ... }
 */
function extractIncoming(body) {
  if (!body) return { messageId: null, from: null, raw: body };

  // If body.messages array (your sample)
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const m = body.messages[0];
    return {
      messageId: m.id || m.msg_id || m.message_id || m?.id || null,
      from: m.from || m.sender || m.chat_id || m?.chat_id || null,
      raw: m
    };
  }

  // If body.data array common in some webhook formats
  if (Array.isArray(body.data) && body.data.length > 0) {
    const d = body.data[0];
    return {
      messageId: d.id || d.message_id || d.msg_id || null,
      from: d.from || d.sender || d?.message?.from || d?.phone || null,
      raw: d
    };
  }

  // Facebook-like entry/changes
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
    } catch (e) {
      // fallthrough
    }
  }

  // Generic top-level fields
  return {
    messageId: body.id || body.message_id || body.msg_id || (new Date().getTime().toString()),
    from: body.from || body.sender || body.phone || null,
    raw: body
  };
}

/**
 * Try multiple payload shapes for Whapi until one works.
 * Returns axios response on success, throws the final error on failure.
 */
async function sendDocumentWhapi(toPhone, mediaId) {
  const baseHeaders = { 'Authorization': `Bearer ${SEND_API_KEY}` };
  const attempts = [];

  // Attempt 1: JSON with media_id (simple)
  attempts.push({
    name: 'json_media_id',
    fn: async () => {
      const payload = { to: toPhone, media_id: mediaId, filename: PDF_FILENAME, type: 'document' };
      return axios.post(SEND_URL, payload, { headers: { ...baseHeaders, 'Content-Type': 'application/json' }, timeout: SEND_TIMEOUT_MS });
    }
  });

  // Attempt 2: JSON with media object { media: "<id>", filename }
  attempts.push({
    name: 'json_media_object',
    fn: async () => {
      const payload = { to: toPhone, media: { media: mediaId, filename: PDF_FILENAME, type: 'document' } };
      return axios.post(SEND_URL, payload, { headers: { ...baseHeaders, 'Content-Type': 'application/json' }, timeout: SEND_TIMEOUT_MS });
    }
  });

  // Attempt 3: JSON with document object (WhatsApp Cloud-like)
  attempts.push({
    name: 'json_document_object',
    fn: async () => {
      const payload = { to: toPhone, document: { id: mediaId, filename: PDF_FILENAME } };
      return axios.post(SEND_URL, payload, { headers: { ...baseHeaders, 'Content-Type': 'application/json' }, timeout: SEND_TIMEOUT_MS });
    }
  });

  // Attempt 4: multipart where `media` is a JSON string containing { media: "<id>" }
  attempts.push({
    name: 'multipart_media_json_field',
    fn: async () => {
      const form = new FormData();
      form.append('to', toPhone);
      // Some endpoints want `media` as a JSON object string
      form.append('media', JSON.stringify({ media: mediaId, filename: PDF_FILENAME, type: 'document' }));
      return axios.post(SEND_URL, form, { headers: { ...baseHeaders, ...form.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity, timeout: Math.max(SEND_TIMEOUT_MS, 20000) });
    }
  });

  // Attempt 5: multipart with media_id field (fallback)
  attempts.push({
    name: 'multipart_media_id_field',
    fn: async () => {
      const form = new FormData();
      form.append('to', toPhone);
      form.append('media_id', mediaId);
      form.append('filename', PDF_FILENAME);
      return axios.post(SEND_URL, form, { headers: { ...baseHeaders, ...form.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity, timeout: Math.max(SEND_TIMEOUT_MS, 20000) });
    }
  });

  // Run attempts in sequence, returning on first success
  let lastErr = null;
  for (const a of attempts) {
    try {
      console.log(`Whapi attempt: ${a.name} -> ${SEND_URL}`);
      const resp = await a.fn();
      console.log(`Whapi attempt ${a.name} succeeded: status=${resp.status}`);
      return resp;
    } catch (err) {
      lastErr = err;
      console.warn(`Whapi attempt ${a.name} failed:`, err?.response?.status, err?.response?.data || err.message);
      // If 401/403 treat as fatal and throw immediately
      const status = err?.response?.status;
      if (status && [401, 403].includes(status)) {
        throw err;
      }
      // otherwise continue to next attempt
    }
  }

  // If we reach here, all attempts failed - throw last error
  throw lastErr || new Error('Unknown Whapi send failure');
}

app.post('/webhook', async (req, res) => {
  try {
    if (VERIFY_TOKEN) {
      const token = req.headers['x-whapi-token'] || req.headers['x-webhook-token'] || req.headers['x-hub-signature'] || null;
      if (token !== VERIFY_TOKEN) {
        console.warn('Webhook verification failed - token mismatch');
        return res.status(401).send('invalid token');
      }
    }

    const incoming = extractIncoming(req.body);
    const messageId = incoming.messageId || (new Date().getTime().toString());
    // Normalize 'from' sometimes includes chat_id like 9190...@s.whatsapp.net or plain phone
    let from = incoming.from || null;
    if (typeof from === 'string' && from.includes('@')) {
      // if it's a JID, extract phone portion
      from = from.split('@')[0];
    }

    if (!from) {
      console.warn('Could not determine sender phone (from) - echoing 400');
      console.debug('incoming raw:', JSON.stringify(incoming.raw || req.body));
      return res.status(400).send('missing-sender');
    }

    if (dedupe.get(messageId)) {
      console.log('Duplicate webhook ignored', messageId);
      return res.status(200).send('ok');
    }
    dedupe.set(messageId, true);

    if (!MEDIA_ID) {
      console.error('MEDIA_ID not configured - cannot send PDF');
      return res.status(202).send('no-media-configured');
    }

    // Attempt to send to Whapi
    try {
      const sendResp = await sendDocumentWhapi(from, MEDIA_ID);
      console.log('Sent document to', from, 'provider_resp_status=', sendResp?.status);
      return res.status(200).send('sent');
    } catch (err) {
      console.error('Final Whapi send failure', err?.response?.status, err?.response?.data || err.message);
      // If provider returned 400 with details, include a short tag for debugging
      if (err?.response?.status === 400) {
        // Do not leak large responses to callers; log them and return a 502 for retry semantics
        console.debug('Whapi 400 body:', JSON.stringify(err?.response?.data || {}));
      }
      return res.status(502).send('send-error');
    }
  } catch (err) {
    console.error('Unhandled webhook error', err);
    return res.status(500).send('internal-error');
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT} - MEDIA_ID present: ${!!MEDIA_ID}`);
});
