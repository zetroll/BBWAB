/**
 * server.js - Whapi.Cloud-ready webhook server to reply with a cached MEDIA_ID PDF.
 *
 * How to use:
 *  - Ensure env vars in Railway:
 *      SEND_URL (optional) - defaults to 'https://gate.whapi.cloud/messages/document'
 *      SEND_API_KEY (required) - Whapi bearer token
 *      MEDIA_ID (required) - ID of the uploaded PDF in Whapi (or add via preupload)
 *      VERIFY_TOKEN (optional) - webhook verification token if Whapi provides one
 *      PDF_FILENAME (optional) - filename shown to recipients (default: document.pdf)
 *
 * Notes:
 *  - The code first tries to send a JSON payload (media_id), then falls back to multipart/form-data.
 *  - For your expected volume (5k messages over 3 days) an in-memory LRU dedupe is sufficient.
 *  - If you want persistent dedupe across restarts, swap LRU with Redis.
 */

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const LRU = require('lru-cache');
const morgan = require('morgan');
const FormData = require('form-data');

const app = express();
app.use(bodyParser.json({ limit: '300kb' }));
app.use(morgan('combined'));

const PORT = process.env.PORT || 8080;
let MEDIA_ID = process.env.MEDIA_ID || null;
const SEND_URL = process.env.SEND_URL || 'https://gate.whapi.cloud/messages/document';
const SEND_API_KEY = process.env.SEND_API_KEY;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || null;
const PDF_FILENAME = process.env.PDF_FILENAME || 'document.pdf';
const DEDUPE_TTL_MS = parseInt(process.env.DEDUPE_TTL_MIN || '5') * 60 * 1000;
const MAX_DEDUPE_ENTRIES = parseInt(process.env.MAX_DEDUPE_ENTRIES || '10000');
const SEND_TIMEOUT_MS = parseInt(process.env.SEND_TIMEOUT_MS || '10000'); // 10s default

if (!SEND_API_KEY) {
  console.error('Missing required env var: SEND_API_KEY. Aborting.');
  process.exit(1);
}

// In-memory dedupe cache (LRU). Good for your traffic.
const dedupe = new LRU({ max: MAX_DEDUPE_ENTRIES, ttl: DEDUPE_TTL_MS });

// Basic health endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', media_id_present: !!MEDIA_ID });
});

// Helper: robust extraction for common webhook shapes
function extractIncoming(body) {
  // Try common shapes: Whapi may send { data: [ { id, from, ... } ] }, or direct message object
  if (!body) return { messageId: null, from: null, raw: body };

  // If body.data is an array
  if (Array.isArray(body.data) && body.data.length > 0) {
    const d = body.data[0];
    // various fields providers use
    return {
      messageId: d.id || d.message_id || d.msg_id || d?.message?.id || null,
      from: d.from || d.sender || d?.message?.from || d?.phone || null,
      raw: d
    };
  }

  // If body.entry / changes shape (facebook-like)
  if (Array.isArray(body.entry) && body.entry.length > 0) {
    try {
      const change = body.entry[0].changes?.[0];
      const val = change?.value || body.entry[0];
      const msg = (val.messages && val.messages[0]) || val.message || val;
      return {
        messageId: msg?.id || msg?.message_id || msg?.msg_id || null,
        from: msg?.from || msg?.sender || val?.phone || null,
        raw: body
      };
    } catch (e) {
      // fallthrough
    }
  }

  // Fallback common top-level fields
  return {
    messageId: body.id || body.message_id || body.msg_id || (new Date().getTime().toString()),
    from: body.from || body.sender || body.phone || null,
    raw: body
  };
}

// Helper: send document through Whapi with JSON then multipart fallback
async function sendDocumentWhapi(toPhone, mediaId) {
  const headersBase = {
    'Authorization': `Bearer ${SEND_API_KEY}`
  };

  // 1) Try JSON-style send
  try {
    const jsonPayload = {
      to: toPhone,
      media_id: mediaId,
      filename: PDF_FILENAME,
      type: 'document'
    };
    const resp = await axios.post(SEND_URL, jsonPayload, {
      headers: { ...headersBase, 'Content-Type': 'application/json' },
      timeout: SEND_TIMEOUT_MS
    });
    return resp;
  } catch (err) {
    // Log and fall through to multipart fallback
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.warn('Whapi JSON send failed:', status, data || err.message);
    // if it's an unrecoverable error like 401, bubble up immediately
    if (status && [401, 403].includes(status)) throw err;
  }

  // 2) Multipart/form-data fallback (some gateways prefer form fields)
  try {
    const form = new FormData();
    form.append('to', toPhone);
    form.append('media_id', mediaId);
    form.append('filename', PDF_FILENAME);
    form.append('type', 'document');

    const resp = await axios.post(SEND_URL, form, {
      headers: { ...headersBase, ...form.getHeaders() },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: Math.max(SEND_TIMEOUT_MS, 20000)
    });
    return resp;
  } catch (err) {
    // Final failure - throw so caller can return 502 to webhook sender
    console.error('Whapi multipart send failed:', err?.response?.status, err?.response?.data || err.message);
    throw err;
  }
}

// Webhook receiver
app.post('/webhook', async (req, res) => {
  try {
    // optional verification: many providers include a token header
    if (VERIFY_TOKEN) {
      // Whapi may send a header like x-whapi-token or x-webhook-token - check both
      const token = req.headers['x-whapi-token'] || req.headers['x-webhook-token'] || req.headers['x-hub-signature'] || null;
      if (token !== VERIFY_TOKEN) {
        console.warn('Webhook verification failed - token mismatch');
        return res.status(401).send('invalid token');
      }
    }

    const incoming = extractIncoming(req.body);
    const messageId = incoming.messageId || (new Date().getTime().toString());
    const from = incoming.from || incoming.raw?.from || incoming.raw?.sender || null;

    if (!from) {
      console.warn('Could not determine sender phone (from) - echoing 400');
      console.debug('incoming raw:', JSON.stringify(incoming.raw || req.body));
      return res.status(400).send('missing-sender');
    }

    // Dedupe: ignore repeated webhook deliveries
    if (dedupe.get(messageId)) {
      console.log('Duplicate webhook ignored', messageId);
      return res.status(200).send('ok');
    }
    dedupe.set(messageId, true);

    // Ensure MEDIA_ID present
    if (!MEDIA_ID) {
      console.error('MEDIA_ID not configured - cannot send PDF');
      // ack but indicate not processed so you can see the event (202)
      return res.status(202).send('no-media-configured');
    }

    // Attempt to send
    let sendResp;
    try {
      sendResp = await sendDocumentWhapi(from, MEDIA_ID);
    } catch (err) {
      // send failed - log and return 502 to indicate temporary error (webhook sender may retry)
      console.error('Send API error', err?.response?.status, err?.response?.data || err.message);
      return res.status(502).send('send-error');
    }

    // success - respond 200
    console.log('Sent document to', from, 'provider_resp_status=', sendResp?.status);
    return res.status(200).send('sent');
  } catch (err) {
    console.error('Unhandled webhook error', err);
    return res.status(500).send('internal-error');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT} - MEDIA_ID present: ${!!MEDIA_ID}`);
});
