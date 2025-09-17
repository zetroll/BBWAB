/**
 * server.js - Sequential send: quick text then document (Whapi.Cloud)
 *
 * Usage:
 *  - Set SEND_API_KEY, MEDIA_ID in Railway env vars.
 *  - Optionally set SEND_URL (document endpoint) and SEND_TEXT_URL (text endpoint).
 *
 * Behavior:
 *  - On webhook: send short text reply first.
 *  - If text send succeeds, attempt document send.
 *  - Logs both steps clearly for debugging.
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

/* Send text via Whapi - adjust payload shape if needed */
async function sendTextWhapi(toPhone, text) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, 'Content-Type': 'application/json' };
  const payload = {
    to: toPhone,
    type: 'text',
    text: { body: text }
  };
  return axios.post(SEND_TEXT_URL, payload, { headers, timeout: SEND_TIMEOUT_MS });
}

/* Send document via Whapi using media as string (JSON) */
async function sendDocumentWhapi(toPhone, mediaId) {
  const baseHeaders = { Authorization: `Bearer ${SEND_API_KEY}`, 'Content-Type': 'application/json' };

  const payload = {
    to: toPhone,
    media: String(mediaId),
    filename: PDF_FILENAME,
    type: 'document'
  };
  return axios.post(SEND_URL, payload, { headers: baseHeaders, timeout: SEND_TIMEOUT_MS });
}

/* Fallback multipart document send with media string (if JSON fails) */
async function sendDocumentMultipartWhapi(toPhone, mediaId) {
  const headersBase = { Authorization: `Bearer ${SEND_API_KEY}` };
  const form = new FormData();
  form.append('to', toPhone);
  form.append('media', String(mediaId));
  form.append('filename', PDF_FILENAME);
  form.append('type', 'document');
  return axios.post(SEND_URL, form, { headers: { ...headersBase, ...form.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity, timeout: Math.max(SEND_TIMEOUT_MS, 20000) });
}

/* Webhook handler: text then document */
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
    let from = incoming.from || null;
    if (typeof from === 'string' && from.includes('@')) {
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

    // Step 1: send quick text reply
    const quickText = process.env.QUICK_TEXT || 'Thanks for reaching us — sending the document now.';
    try {
      console.log('Sending quick text to', from);
      const textResp = await sendTextWhapi(from, quickText);
      console.log('Quick text send success:', textResp.status);
    } catch (err) {
      console.error('Quick text send failed:', err?.response?.status, err?.response?.data || err.message);
      // Return 502 so webhook sender may retry; or respond 200 if you prefer to swallow
      return res.status(502).send('text-send-failed');
    }

    // Step 2: attempt document send (only if MEDIA_ID present)
    if (!MEDIA_ID) {
      console.error('MEDIA_ID not configured - cannot send PDF');
      return res.status(200).send('text-sent-no-media');
    }

    try {
      console.log('Attempting document send (JSON) to', from);
      const docResp = await sendDocumentWhapi(from, MEDIA_ID);
      console.log('Document JSON send success:', docResp.status);
      return res.status(200).send('text-and-document-sent');
    } catch (errJson) {
      console.warn('Document JSON send failed:', errJson?.response?.status, errJson?.response?.data || errJson.message);
      // Try multipart fallback
      try {
        console.log('Attempting document send (multipart) to', from);
        const docResp2 = await sendDocumentMultipartWhapi(from, MEDIA_ID);
        console.log('Document multipart send success:', docResp2.status);
        return res.status(200).send('text-and-document-sent-multipart');
      } catch (errMulti) {
        console.error('Document multipart send failed:', errMulti?.response?.status, errMulti?.response?.data || errMulti.message);
        return res.status(502).send('document-send-failed');
      }
    }

  } catch (err) {
    console.error('Unhandled webhook error', err);
    return res.status(500).send('internal-error');
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT} - MEDIA_ID present: ${!!MEDIA_ID}`);
});
