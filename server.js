const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const LRU = require('lru-cache');
const morgan = require('morgan');

const app = express();
app.use(bodyParser.json({ limit: '200kb' }));
app.use(morgan('combined'));

const PORT = process.env.PORT || 8080;
let MEDIA_ID = process.env.MEDIA_ID || null;
const SEND_URL = process.env.SEND_URL;
const SEND_API_KEY = process.env.SEND_API_KEY;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || null;
const DEDUPE_TTL_MS = parseInt(process.env.DEDUPE_TTL_MS || '5') * 60 * 1000;
const MAX_DEDUPE_ENTRIES = parseInt(process.env.MAX_DEDUPE_ENTRIES || '10000');

if (!SEND_URL || !SEND_API_KEY) {
  console.error('Required env vars: SEND_URL, SEND_API_KEY');
  process.exit(1);
}

const dedupe = new LRU({ max: MAX_DEDUPE_ENTRIES, ttl: DEDUPE_TTL_MS });

app.get('/health', (req, res) => res.json({ status: 'ok', media_id_present: !!MEDIA_ID }));

app.post('/webhook', async (req, res) => {
  try {
    if (VERIFY_TOKEN) {
      const token = req.headers['x-whapi-token'] || req.headers['x-webhook-token'] || null;
      if (token !== VERIFY_TOKEN) {
        console.warn('Webhook verify failed');
        return res.status(401).send('invalid token');
      }
    }

    const body = req.body || {};
    const incomingMsg = (body?.data && Array.isArray(body.data) && body.data[0]) || body;
    const messageId = incomingMsg?.id || incomingMsg?.message_id || incomingMsg?.message?.id || (new Date().getTime().toString());
    const from = incomingMsg?.from || incomingMsg?.sender || incomingMsg?.message?.from || incomingMsg?.phone || 'unknown';

    if (dedupe.get(messageId)) {
      console.log('Duplicate webhook, ignoring', messageId);
      return res.status(200).send('ok');
    }
    dedupe.set(messageId, true);

    if (!MEDIA_ID) {
      console.error('MEDIA_ID not configured. Cannot send PDF.');
      return res.status(202).send('no-media-configured');
    }

    const sendPayload = {
      to: from,
      type: 'document',
      document: {
        id: MEDIA_ID,
        filename: process.env.PDF_FILENAME || 'document.pdf'
      }
    };

    const headers = {
      'Authorization': `Bearer ${SEND_API_KEY}`,
      'Content-Type': 'application/json'
    };

    const timeoutMs = parseInt(process.env.SEND_TIMEOUT_MS || '10000');

    let sendResp;
    try {
      sendResp = await axios.post(SEND_URL, sendPayload, { headers, timeout: timeoutMs });
    } catch (err) {
      console.error('Send API error', err?.response?.status, err?.response?.data || err.message);
      return res.status(502).send('send-error');
    }

    console.log('Sent document to', from, 'provider_resp_status=', sendResp.status);
    return res.status(200).send('sent');
  } catch (err) {
    console.error('Unhandled webhook error', err);
    return res.status(500).send('internal-error');
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT} - MEDIA_ID present: ${!!MEDIA_ID}`);
});
