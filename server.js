/**
 * server.js - duplicate-safe, prioritized document-first flow
 *
 * Changes from previous:
 *  - sentCache LRU to ensure idempotent sends (skip duplicate sends)
 *  - job.locked flag to avoid double-processing inside one process
 *  - JOB_WORKER_BATCH = 1 => one job per tick (less noisy, safer)
 *  - TEXT_TIMEOUT_MS default bumped to 5000ms
 *
 * NOTE: in-memory queue & LRU are fine for short-lived runs. For production-high-reliability
 * use Redis/Cloud PubSub for persistence and distributed locking.
 */

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const FormData = require("form-data");
const LRU = require("lru-cache");
const morgan = require("morgan");
const crypto = require("crypto");

const app = express();
app.use(bodyParser.json({ limit: "500kb" }));
app.use(morgan("combined"));

/* -------- CONFIG -------- */
const PORT = process.env.PORT || 8080;
const SEND_API_KEY = process.env.SEND_API_KEY;
const SEND_TEXT_URL = process.env.SEND_TEXT_URL || "https://gate.whapi.cloud/messages/text";
const SEND_DOC_URL = process.env.SEND_DOC_URL || "https://gate.whapi.cloud/messages/document";
const SEND_INTERACTIVE_URL = process.env.SEND_INTERACTIVE_URL || "https://gate.whapi.cloud/messages/interactive";

const INTRO_TEXT = process.env.INTRO_TEXT || "Hi, I'm Dileep, and I want to share my favourite products with you!";
const INTERACTIVE_BODY = process.env.INTERACTIVE_BODY || "Choose which category you are interested in:";
const TV_BUTTON_TITLE = process.env.TV_BUTTON_TITLE || "TV";
const TV_BUTTON_ID = process.env.TV_BUTTON_ID || "tv";
const TV_MEDIA_ID = process.env.TV_MEDIA_ID || "";
const AC_BUTTON_TITLE = process.env.AC_BUTTON_TITLE || "AC";
const AC_BUTTON_ID = process.env.AC_BUTTON_ID || "ac";
const AC_MEDIA_ID = process.env.AC_MEDIA_ID || "";
const REFRIGERATOR_BUTTON_TITLE = process.env.REFRIGERATOR_BUTTON_TITLE || "Refrigerator";
const REFRIGERATOR_BUTTON_ID = process.env.REFRIGERATOR_BUTTON_ID || "refrigerator";
const REFRIGERATOR_MEDIA_ID = process.env.REFRIGERATOR_MEDIA_ID || "";
const WASHING_MACHINE_BUTTON_TITLE = process.env.WASHING_MACHINE_BUTTON_TITLE || "Washing Machine";
const WASHING_MACHINE_BUTTON_ID = process.env.WASHING_MACHINE_BUTTON_ID || "washing_machine";
const WASHING_MACHINE_MEDIA_ID = process.env.WASHING_MACHINE_MEDIA_ID || "";
const KITCHEN_HOME_BUTTON_TITLE = process.env.KITCHEN_HOME_BUTTON_TITLE || "Kitchen & Home Deals";
const KITCHEN_HOME_BUTTON_ID = process.env.KITCHEN_HOME_BUTTON_ID || "kitchen_home";
const KITCHEN_HOME_MEDIA_ID = process.env.KITCHEN_HOME_MEDIA_ID || "";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || null;
const SENDER_PHONE = process.env.SENDER_PHONE || null;

const TEXT_TIMEOUT_MS = parseInt(process.env.TEXT_TIMEOUT_MS || "8000", 10); // 8s for initial attempts
const TEXT_IMMEDIATE_TRIES = parseInt(process.env.TEXT_IMMEDIATE_TRIES || "1", 10); // single quick try
const DOC_TIMEOUT_MS = parseInt(process.env.DOC_TIMEOUT_MS || "30000", 10);
const DOC_RETRIES = parseInt(process.env.DOC_RETRIES || "1", 10);
const JOB_TEXT_TIMEOUT_MS = parseInt(process.env.JOB_TEXT_TIMEOUT_MS || "30000", 10); // longer timeout for job retries

const JOB_MAX_RETRIES = parseInt(process.env.JOB_MAX_RETRIES || "2", 10); // reduced from 5
const JOB_RETRY_BASE_MS = parseInt(process.env.JOB_RETRY_BASE_MS || "2000", 10);
const ADMIN_KEY = process.env.ADMIN_KEY || null;

const DEDUPE_TTL_MIN = parseInt(process.env.DEDUPE_TTL_MIN || "5", 10);
const DEDUPE_TTL_MS = DEDUPE_TTL_MIN * 60 * 1000;
const MAX_DEDUPE_ENTRIES = parseInt(process.env.MAX_DEDUPE_ENTRIES || "10000", 10);

const PHANTOM_DELIVERY_WINDOW_MS = parseInt(process.env.PHANTOM_DELIVERY_WINDOW_MS || "120000", 10); // 2 minutes

// Rate limiting for 5 TPS max
const RATE_LIMIT_TPS = parseInt(process.env.RATE_LIMIT_TPS || "5", 10);
const rateLimitWindow = new LRU({ max: 1000, ttl: 1000 }); // 1 second windows

// Outbound message tracking to prevent phantom delivery duplicates
const outboundMessageCache = new LRU({ max: 10000, ttl: PHANTOM_DELIVERY_WINDOW_MS });

if (!SEND_API_KEY) {
  console.error("Missing SEND_API_KEY - aborting.");
  process.exit(1);
}
if (!TV_MEDIA_ID || !AC_MEDIA_ID || !REFRIGERATOR_MEDIA_ID || !WASHING_MACHINE_MEDIA_ID || !KITCHEN_HOME_MEDIA_ID) {
  console.error("Missing one or more media IDs for categories - aborting.");
  process.exit(1);
}

/* -------- UTIL -------- */

function logAxiosError(tag, err) {
  try {
    console.error(`--- ${tag} - Error:`, err?.message || err);
    if (err?.code) console.error(`${tag} - code:`, err.code);
    if (err?.config) {
      const cfg = {
        url: err.config.url,
        method: err.config.method,
        headers: err.config.headers,
        data: typeof err.config.data === "string" ? err.config.data.slice(0, 2000) : err.config.data,
      };
      console.error(`${tag} - request:`, JSON.stringify(cfg));
    }
    if (err?.response) {
      console.error(`${tag} - response.status:`, err.response.status);
      try { console.error(`${tag} - response.headers:`, JSON.stringify(err.response.headers).slice(0, 2000)); } catch {}
      try { console.error(`${tag} - response.body:`, JSON.stringify(err.response.data).slice(0, 8000)); } catch {}
    }
  } catch (ex) { console.error("Failed to log axios error fully", ex); }
}

function normalizePhone(raw) {
  if (!raw || typeof raw !== "string") return null;
  raw = raw.trim();
  if (raw.includes("@")) {
    const parts = raw.split("@");
    const user = parts[0].replace(/\D+/g, "");
    const domain = parts.slice(1).join("@");
    if (!user) return null;
    return `${user}@${domain}`;
  }
  const digits = raw.replace(/\D+/g, "");
  return digits.length >= 9 ? digits : null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* Enhanced request tracing and fingerprinting */
function sha256hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function createRequestTrace(type, to, payload) {
  return {
    id: crypto.randomUUID(),
    type,
    to: normalizePhone(to) || to,
    payloadHash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0,8),
    startTime: Date.now(),
    attempts: 0
  };
}

function createMessageFingerprint(to, content, type) {
  const normalized = {
    to: normalizePhone(to),
    content: type === 'text' ? content : (content.media || content.body || JSON.stringify(content)),
    type,
    timestamp: Math.floor(Date.now() / 60000) // Change every minute to allow retries
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0,12);
}

function analyzeWhapiResponse(trace, response, error) {
  const timing = Date.now() - trace.startTime;
  const analysis = {
    timing: `${timing}ms`,
    status: response?.status || 'ERROR',
    hasPreview: response?.data?.preview ? 'YES' : 'NO',
    hasLinkPreview: response?.data?.link_preview ? 'YES' : 'NO',
    hasThumbnail: response?.data?.thumbnail ? 'YES' : 'NO',
    responseSize: JSON.stringify(response?.data || {}).length,
    errorType: error?.code || error?.message?.slice(0,50) || 'none',
    responseData: JSON.stringify(response?.data || {}).slice(0, 400) // increased for preview analysis
  };
  console.log(`TRACE ${trace.id}: ${trace.type} ${analysis.timing}`, analysis);

  // Additional preview diagnostics
  if (response?.data) {
    const data = response.data;
    if (data.message_id) console.log(`TRACE ${trace.id}: Message ID: ${data.message_id}`);
    if (data.preview_url) console.log(`TRACE ${trace.id}: Preview URL: ${data.preview_url}`);
    if (data.media_url) console.log(`TRACE ${trace.id}: Media URL: ${data.media_url}`);
  }

  return analysis;
}

function checkRateLimit() {
  const now = Date.now();
  const currentSecond = Math.floor(now / 1000);
  const currentCount = rateLimitWindow.get(currentSecond) || 0;

  if (currentCount >= RATE_LIMIT_TPS) {
    console.warn(`Rate limit exceeded: ${currentCount}/${RATE_LIMIT_TPS} TPS`);
    return false;
  }

  rateLimitWindow.set(currentSecond, currentCount + 1);
  return true;
}

// URL shortening for performance optimization
async function shortenUrlIfLong(url, threshold = 100) {
  if (!url || url.length <= threshold) return url;

  try {
    console.log(`URL shortening: ${url.length} chars, attempting TinyURL...`);
    const response = await axios.post(
      'http://tinyurl.com/api-create.php',
      `url=${encodeURIComponent(url)}`,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 5000
      }
    );
    const shortUrl = response.data?.trim();
    if (shortUrl && shortUrl.startsWith('http')) {
      console.log(`URL shortened: ${url.length} -> ${shortUrl.length} chars`);
      return shortUrl;
    }
  } catch (error) {
    console.warn('URL shortening failed:', error.message);
  }
  return url; // Return original if shortening fails
}

/* -------- DEDUPE & SENT CACHE -------- */
const dedupe = new LRU({ max: MAX_DEDUPE_ENTRIES, ttl: DEDUPE_TTL_MS });

// Sent cache prevents duplicate API calls for same to+payload within TTL.
// Reduced TTL - allow same user to get same content multiple times per session
const SENT_CACHE_TTL_MS = parseInt(process.env.SENT_CACHE_TTL_MS || "30000", 10); // 30 seconds only
const sentCache = new LRU({ max: 20000, ttl: SENT_CACHE_TTL_MS });

app.get("/health", (req, res) => res.json({ ok: true }));

// URL testing endpoint for diagnostics
app.post("/test-url", async (req, res) => {
  const { to, url, shortener } = req.body;
  if (!to || !url) return res.status(400).json({ error: "to and url required" });

  const normalizedTo = normalizePhone(to) || to;

  try {
    let testUrl = url;

    // Optional URL shortening for testing
    if (shortener === 'tinyurl') {
      const tinyResponse = await axios.post('http://tinyurl.com/api-create.php', `url=${encodeURIComponent(url)}`, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      });
      testUrl = tinyResponse.data;
      console.log(`URL shortened: ${url.length} chars -> ${testUrl.length} chars`);
    }

    const startTime = Date.now();
    const response = await sendTextOnce(normalizedTo, testUrl, 15000); // 15s timeout for testing
    const timing = Date.now() - startTime;

    return res.json({
      success: true,
      originalUrl: url,
      sentUrl: testUrl,
      timing: `${timing}ms`,
      response: response?.status || 'unknown'
    });
  } catch (error) {
    console.error('URL test failed:', error.message);
    return res.status(500).json({
      error: error.message,
      originalUrl: url,
      timing: error.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR'
    });
  }
});

/* -------- JOB QUEUE (in-memory) -------- */
const jobs = new Map();
let jobCounter = 0;
function makeJobId() { jobCounter++; return `${Date.now()}-${jobCounter}`; }
function addJob(job) {
  jobs.set(job.id, job);
  console.log("Queued job", job.id, job.type, "attempts", job.attempts, "nextAt", new Date(job.nextAttemptAt).toISOString());
}

/* We process only up to JOB_WORKER_BATCH jobs per tick to avoid duplicates/noisy logs.
   We also set job.locked before processing to avoid concurrent processing within the same process.
*/
const JOB_WORKER_INTERVAL_MS = 2000;
const JOB_WORKER_BATCH = 1;

setInterval(async () => {
  const now = Date.now();
  const ready = Array.from(jobs.values()).filter((j) => j.nextAttemptAt <= now && !j.locked).slice(0, JOB_WORKER_BATCH);
  for (const job of ready) {
    // simple locking to avoid double-processing inside process
    job.locked = true;
    jobs.set(job.id, job);
    console.log("Processing job", job.id, job.type, "attempt", job.attempts + 1, "/", job.maxAttempts);
    try {
      // Enhanced idempotency check using fingerprints
      const fingerprint = job.fingerprint || (job.type === "doc" ? createMessageFingerprint(job.to, { media: job.media }, 'document') : createMessageFingerprint(job.to, job.body, 'text'));
      if (sentCache.get(fingerprint)) {
        console.log(`Job ${job.id} skipped - already sent (fingerprint: ${fingerprint})`);
        jobs.delete(job.id);
        continue;
      }

      if (job.type === "doc") {
        await sendDocumentRobust(job.to, job.media, job.filename);
        console.log(`Job success doc ${job.id} (fingerprint: ${fingerprint})`);
        jobs.delete(job.id);
      } else if (job.type === "text") {
        // Use longer timeout for job retries
        await sendTextOnce(job.to, job.body, JOB_TEXT_TIMEOUT_MS);
        console.log(`Job success text ${job.id} (fingerprint: ${fingerprint})`);
        jobs.delete(job.id);
      } else {
        console.warn("Unknown job type", job.type, job.id);
        jobs.delete(job.id);
      }
    } catch (err) {
      job.attempts++;
      job.locked = false;
      logAxiosError(`Job ${job.id} failed`, err);
      if (job.attempts >= job.maxAttempts) {
        console.error(`Job ${job.id} exhausted attempts (${job.attempts}) - removing`);
        jobs.delete(job.id);
      } else {
        const backoff = JOB_RETRY_BASE_MS * Math.pow(2, job.attempts - 1);
        job.nextAttemptAt = Date.now() + backoff;
        job.locked = false;
        jobs.set(job.id, job);
        console.log(`Job ${job.id} rescheduled in ${backoff}ms`);
      }
    }
  }
}, JOB_WORKER_INTERVAL_MS);

/* -------- WHAPI helpers -------- */

async function sendTextOnce(toPhone, body, timeoutMs) {
  const trace = createRequestTrace('text', toPhone, { body });
  const fingerprint = createMessageFingerprint(toPhone, body, 'text');

  if (sentCache.get(fingerprint)) {
    console.log(`TRACE ${trace.id}: sendTextOnce SKIPPED (fingerprint: ${fingerprint})`, toPhone);
    return { skipped: true, fingerprint };
  }

  const headers = {
    Authorization: `Bearer ${SEND_API_KEY}`,
    "Content-Type": "application/json",
    "X-Request-Id": trace.id
  };
  const payload = { to: String(toPhone), body: String(body) };

  if (!checkRateLimit()) {
    throw new Error('Rate limit exceeded - please retry later');
  }

  try {
    const resp = await axios.post(SEND_TEXT_URL, payload, { headers, timeout: timeoutMs });
    analyzeWhapiResponse(trace, resp);
    sentCache.set(fingerprint, true);

    // Track outbound message to prevent phantom delivery duplicates
    const messageKey = `out:${toPhone}:${crypto.createHash('sha256').update(body).digest('hex').slice(0,12)}`;
    outboundMessageCache.set(messageKey, { fingerprint, timestamp: Date.now(), traceId: trace.id });

    console.log(`TRACE ${trace.id}: sendTextOnce SUCCESS (fingerprint: ${fingerprint})`);
    return resp;
  } catch (error) {
    analyzeWhapiResponse(trace, null, error);

    // Even on failure, track the attempt to catch phantom deliveries
    const messageKey = `out:${toPhone}:${crypto.createHash('sha256').update(body).digest('hex').slice(0,12)}`;
    outboundMessageCache.set(messageKey, { fingerprint, timestamp: Date.now(), traceId: trace.id, failed: true });

    throw error;
  }
}

async function sendDocumentJsonOnce(toPhone, mediaId, filename, timeoutMs) {
  const trace = createRequestTrace('doc-json', toPhone, { media: mediaId, filename });
  const fingerprint = createMessageFingerprint(toPhone, { media: mediaId }, 'document');

  if (sentCache.get(fingerprint)) {
    console.log(`TRACE ${trace.id}: sendDocumentJsonOnce SKIPPED (fingerprint: ${fingerprint})`, toPhone, mediaId);
    return { skipped: true, fingerprint };
  }

  const headers = {
    Authorization: `Bearer ${SEND_API_KEY}`,
    "Content-Type": "application/json",
    "X-Request-Id": trace.id
  };
  const payload = { to: String(toPhone), media: String(mediaId), filename: filename ? String(filename) : undefined, type: "document" };

  if (!checkRateLimit()) {
    throw new Error('Rate limit exceeded - please retry later');
  }

  try {
    const resp = await axios.post(SEND_DOC_URL, payload, { headers, timeout: timeoutMs });
    analyzeWhapiResponse(trace, resp);
    sentCache.set(fingerprint, true);

    // Track outbound document to prevent phantom delivery duplicates
    const messageKey = `out:${toPhone}:doc:${mediaId}`;
    outboundMessageCache.set(messageKey, { fingerprint, timestamp: Date.now(), traceId: trace.id });

    console.log(`TRACE ${trace.id}: sendDocumentJsonOnce SUCCESS (fingerprint: ${fingerprint})`);
    return resp;
  } catch (error) {
    analyzeWhapiResponse(trace, null, error);

    // Track failed document attempts too
    const messageKey = `out:${toPhone}:doc:${mediaId}`;
    outboundMessageCache.set(messageKey, { fingerprint, timestamp: Date.now(), traceId: trace.id, failed: true });

    throw error;
  }
}

async function sendDocumentMultipartOnce(toPhone, mediaId, filename, timeoutMs) {
  const trace = createRequestTrace('doc-multipart', toPhone, { media: mediaId, filename });
  const fingerprint = createMessageFingerprint(toPhone, { media: mediaId }, 'document');

  if (sentCache.get(fingerprint)) {
    console.log(`TRACE ${trace.id}: sendDocumentMultipartOnce SKIPPED (fingerprint: ${fingerprint})`, toPhone, mediaId);
    return { skipped: true, fingerprint };
  }

  const form = new FormData();
  form.append("to", String(toPhone));
  form.append("media", String(mediaId));
  if (filename) form.append("filename", String(filename));
  form.append("type", "document");
  const headers = {
    Authorization: `Bearer ${SEND_API_KEY}`,
    "X-Request-Id": trace.id,
    ...form.getHeaders()
  };

  try {
    const resp = await axios.post(SEND_DOC_URL, form, { headers, timeout: timeoutMs, maxContentLength: Infinity, maxBodyLength: Infinity });
    analyzeWhapiResponse(trace, resp);
    sentCache.set(fingerprint, true);
    console.log(`TRACE ${trace.id}: sendDocumentMultipartOnce SUCCESS (fingerprint: ${fingerprint})`);
    return resp;
  } catch (error) {
    analyzeWhapiResponse(trace, null, error);
    throw error;
  }
}

/* Robust document sender */
async function sendDocumentRobust(toPhone, mediaId, filename) {
  let lastErr = null;
  for (let attempt = 0; attempt <= DOC_RETRIES; attempt++) {
    const name = `docAttempt#${attempt + 1}`;
    try {
      console.log(`${name} trying JSON (timeout ${DOC_TIMEOUT_MS}ms) to ${toPhone}`);
      const r = await sendDocumentJsonOnce(toPhone, mediaId, filename, DOC_TIMEOUT_MS);
      if (r && r.skipped) { console.log(`${name}: skipped (already sent)`); return r; }
      console.log(`${name} JSON success`, r.status);
      return r;
    } catch (errJson) {
      lastErr = errJson;
      logAxiosError(`${name} JSON`, errJson);
      const s = errJson?.response?.status;
      if (s && [401, 403].includes(s)) throw errJson;
      try {
        console.log(`${name} trying multipart fallback (timeout ${DOC_TIMEOUT_MS}ms)`);
        const r2 = await sendDocumentMultipartOnce(toPhone, mediaId, filename, DOC_TIMEOUT_MS);
        if (r2 && r2.skipped) { console.log(`${name} multipart: skipped (already sent)`); return r2; }
        console.log(`${name} multipart success`, r2.status);
        return r2;
      } catch (errMulti) {
        lastErr = errMulti;
        logAxiosError(`${name} multipart`, errMulti);
        const s2 = errMulti?.response?.status;
        if (s2 && [401, 403].includes(s2)) throw errMulti;
      }
    }
    if (attempt < DOC_RETRIES) {
      const backoff = 1000 * Math.pow(2, attempt);
      console.log(`sendDocumentRobust waiting ${backoff}ms before retry`);
      await sleep(backoff);
    }
  }
  throw lastErr || new Error("Document send exhausted attempts");
}

/* sendTextRobustOrQueue: quick immediate tries, then queue with longer timeout */
async function sendTextRobustOrQueue(toPhone, body) {
  // Optimize long URLs for better WHAPI performance
  const optimizedBody = await shortenUrlIfLong(body, 120);

  const fingerprint = createMessageFingerprint(toPhone, optimizedBody, 'text');
  if (sentCache.get(fingerprint)) {
    console.log(`sendTextRobustOrQueue: already sent (fingerprint: ${fingerprint}) - skipping`);
    return null;
  }

  for (let i = 0; i < TEXT_IMMEDIATE_TRIES; i++) {
    try {
      console.log(`sendTextRobustOrQueue: quick try ${i + 1} to ${toPhone} (${optimizedBody.length} chars)`);
      const r = await sendTextOnce(toPhone, optimizedBody, TEXT_TIMEOUT_MS);
      if (r && r.skipped) { console.log("sendText quick: skipped (already sent)"); return r; }
      console.log("sendText quick success", r.status);
      return r;
    } catch (err) {
      logAxiosError(`sendText quick try ${i + 1}`, err);
      const s = err?.response?.status;
      if (s && [401, 403].includes(s)) throw err;
      // otherwise continue to next quick try
    }
  }

  // enqueue job for retries with longer timeout
  const jobId = makeJobId();
  const job = {
    id: jobId,
    type: "text",
    to: toPhone,
    body: optimizedBody, // Use optimized/shortened URL
    fingerprint,
    attempts: 0,
    maxAttempts: JOB_MAX_RETRIES,
    nextAttemptAt: Date.now() + JOB_RETRY_BASE_MS,
    locked: false
  };
  addJob(job);
  console.log(`text send queued as job ${jobId} (fingerprint: ${fingerprint})`);
  return null;
}

/* interactive send with merged intro */
async function sendInteractiveButtons(toPhone) {
  const trace = createRequestTrace('interactive', toPhone, { buttons: 'intro+choices' });
  const fingerprint = createMessageFingerprint(toPhone, { type: 'interactive', body: INTRO_TEXT + INTERACTIVE_BODY }, 'interactive');

  if (sentCache.get(fingerprint)) {
    console.log(`TRACE ${trace.id}: sendInteractiveButtons SKIPPED (fingerprint: ${fingerprint})`, toPhone);
    return { skipped: true, fingerprint };
  }

  const headers = {
    Authorization: `Bearer ${SEND_API_KEY}`,
    "Content-Type": "application/json",
    "X-Request-Id": trace.id
  };

  // Merge intro text with interactive body for single API call
  const combinedText = `${INTRO_TEXT}\n\n${INTERACTIVE_BODY}`;

  const payload = {
    body: { text: combinedText },
    action: {
      buttons: [
        { type: "quick_reply", title: TV_BUTTON_TITLE, id: TV_BUTTON_ID },
        { type: "quick_reply", title: AC_BUTTON_TITLE, id: AC_BUTTON_ID },
        { type: "quick_reply", title: REFRIGERATOR_BUTTON_TITLE, id: REFRIGERATOR_BUTTON_ID },
        { type: "quick_reply", title: WASHING_MACHINE_BUTTON_TITLE, id: WASHING_MACHINE_BUTTON_ID },
        { type: "quick_reply", title: KITCHEN_HOME_BUTTON_TITLE, id: KITCHEN_HOME_BUTTON_ID }
      ]
    },
    type: "button",
    to: String(toPhone)
  };

  if (!checkRateLimit()) {
    throw new Error('Rate limit exceeded - please retry later');
  }

  try {
    const resp = await axios.post(SEND_INTERACTIVE_URL, payload, { headers, timeout: TEXT_TIMEOUT_MS });
    analyzeWhapiResponse(trace, resp);
    sentCache.set(fingerprint, true);
    console.log(`TRACE ${trace.id}: sendInteractiveButtons SUCCESS (fingerprint: ${fingerprint})`);
    return resp;
  } catch (error) {
    analyzeWhapiResponse(trace, null, error);
    throw error;
  }
}

/* extract helpers */
function extractCommon(body) {
  if (!body) return { kind: "unknown", raw: body };
  if (Array.isArray(body.statuses) && body.statuses.length > 0) return { kind: "status", statuses: body.statuses, raw: body };
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
    return { kind: "message", messageId: m.id || null, from: m.from || m.sender || null, from_me: !!m.from_me, text: m?.text?.body || m?.body || null, raw: m };
  }
  return { kind: "unknown", raw: body };
}

function extractButtonReply(body) {
  if (!body) return null;
  const m = (body.messages && body.messages[0]) || body.message || body;
  if (m?.interactive?.button_reply) return { id: m.interactive.button_reply.id, title: m.interactive.button_reply.title };
  if (m?.reply?.buttons_reply) return { id: m.reply.buttons_reply.id, title: m.reply.buttons_reply.title };
  if (m?.reply && (m.reply.id || m.reply.title)) return { id: m.reply.id || null, title: m.reply.title || null };
  return null;
}
function normalizeButtonId(rawId) {
  if (!rawId) return null;
  const parts = String(rawId).split(":");
  return parts[parts.length - 1].toLowerCase();
}

// Category-specific success messages with emojis
function getCategoryMessage(categoryId) {
  const messages = {
    'tv': 'Bada screen aur bhi bada drama! 📺 Yeh raha saare ke saare TV deals – just for you.',
    'ac': 'Kaafi cool choice! ❄️ Yeh rahe best deals on AC – all at ₹100/day!',
    'refrigerator': 'Serving cool vibes only! 🧊 Saari ki saari cool deals are here!',
    'washing_machine': 'Ab hogi sirf kaapdo ki dhulayi! 🌀 Here are your deals on Washing Machine!',
    'kitchen_home': 'Ghar ke har kone ke liye ek deal 🏠 only and only for you!'
  };
  return messages[categoryId] || 'Here are your deals!';
}

function getCategoryData(categoryId) {
  const categoryMap = {
    'tv': { mediaId: TV_MEDIA_ID, filename: "Dilip's Favourite TVs.pdf" },
    'ac': { mediaId: AC_MEDIA_ID, filename: "Dilip's Favourite ACs.pdf" },
    'refrigerator': { mediaId: REFRIGERATOR_MEDIA_ID, filename: "Dilip's Favourite Refrigerators.pdf" },
    'washing_machine': { mediaId: WASHING_MACHINE_MEDIA_ID, filename: "Dilip's Favourite Washing Machines.pdf" },
    'kitchen_home': { mediaId: KITCHEN_HOME_MEDIA_ID, filename: "Dilip's Kitchen & Home Deals.pdf" }
  };
  return categoryMap[categoryId];
}

/* -------- ADMIN endpoints -------- */
app.post("/admin/send-doc", async (req, res) => {
  if (ADMIN_KEY) {
    const key = req.headers["x-admin-key"];
    if (!key || key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "invalid admin key" });
  }
  const to = req.query.to;
  const media = req.query.media;
  const name = req.query.name || "test.pdf";
  if (!to || !media) return res.status(400).json({ ok: false, error: "missing to or media query params" });
  try {
    const r = await sendDocumentRobust(normalizePhone(to) || to, media, name);
    return res.json({ ok: true, status: r.status, body: r.data });
  } catch (err) {
    logAxiosError("admin send-doc", err);
    return res.status(500).json({ ok: false, error: err?.message || "failed" });
  }
});

app.get("/admin/failed-jobs", (req, res) => {
  if (ADMIN_KEY) {
    const key = req.headers["x-admin-key"];
    if (!key || key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "invalid admin key" });
  }
  const list = Array.from(jobs.values()).map((j) => ({ id: j.id, type: j.type, to: j.to, attempts: j.attempts, nextAttemptAt: j.nextAttemptAt }));
  return res.json({ ok: true, queued: list });
});

app.post("/admin/retry-job", (req, res) => {
  if (ADMIN_KEY) {
    const key = req.headers["x-admin-key"];
    if (!key || key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "invalid admin key" });
  }
  const jobId = req.query.jobId;
  if (!jobId) return res.status(400).json({ ok: false, error: "jobId required" });
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ ok: false, error: "job not found" });
  job.nextAttemptAt = Date.now();
  job.locked = false;
  jobs.set(jobId, job);
  return res.json({ ok: true, message: "job scheduled" });
});

/* -------- MAIN WEBHOOK -------- */
app.post("/webhook", async (req, res) => {
  try {
    if (VERIFY_TOKEN) {
      const token = req.headers["x-whapi-token"] || req.headers["x-webhook-token"] || null;
      if (token !== VERIFY_TOKEN) return res.status(401).send("invalid token");
    }

    const incoming = extractCommon(req.body);

    if (incoming.kind === "status") {
      console.log("statuses event - ignoring");
      return res.status(200).send("ignored-status");
    }
    if (incoming.kind !== "message") {
      console.log("unknown webhook kind - ignoring");
      return res.status(200).send("ignored");
    }
    if (incoming.from_me) {
      console.log("ignoring from_me echo");
      return res.status(200).send("ignored-from-me");
    }

    const messageId = incoming.messageId || Date.now().toString();
    let rawFrom = incoming.from;
    let from = normalizePhone(rawFrom);
    if (!from) {
      console.warn("invalid from:", JSON.stringify(incoming.raw).slice(0, 300));
      return res.status(400).send("missing-sender");
    }

    // Check for phantom delivery of our own outbound messages (after 'from' is defined)
    if (incoming.text) {
      const messageKey = `out:${from}:${crypto.createHash('sha256').update(incoming.text).digest('hex').slice(0,12)}`;
      const outboundRecord = outboundMessageCache.get(messageKey);
      if (outboundRecord) {
        console.log(`PHANTOM DELIVERY DETECTED (text): ${messageKey} (original trace: ${outboundRecord.traceId})`);
        return res.status(200).send("ignored-phantom-delivery");
      }
    }

    // Check for phantom delivery of documents
    if (incoming.raw?.document?.id) {
      const docId = incoming.raw.document.id;
      const messageKey = `out:${from}:doc:${docId}`;
      const outboundRecord = outboundMessageCache.get(messageKey);
      if (outboundRecord) {
        console.log(`PHANTOM DELIVERY DETECTED (doc): ${messageKey} (original trace: ${outboundRecord.traceId})`);
        return res.status(200).send("ignored-phantom-delivery");
      }
    }

    if (SENDER_PHONE) {
      const normSender = normalizePhone(SENDER_PHONE);
      if (normSender && from === normSender) {
        console.log("Ignoring self messages");
        return res.status(200).send("ignored-self");
      }
    }

    if (dedupe.get(messageId)) {
      console.log("Duplicate webhook ignored", messageId);
      return res.status(200).send("ok");
    }
    dedupe.set(messageId, true);

    // detect button reply
    const btn = extractButtonReply(req.body);
    if (btn && btn.id) {
      const normalizedId = normalizeButtonId(btn.id);
      console.log("Button reply detected:", btn.id, btn.title, "->", normalizedId);

      // Get category data
      const categoryData = getCategoryData(normalizedId);

      if (categoryData) {
        const { mediaId, filename } = categoryData;
        const successMessage = getCategoryMessage(normalizedId);

        // Send success message first
        (async () => {
          try {
            await sendTextOnce(from, successMessage, TEXT_TIMEOUT_MS);
            console.log(`${normalizedId} success message sent`);
          } catch (err) {
            logAxiosError(`${normalizedId} success message failed`, err);
          }
        })();

        // Then send PDF
        (async () => {
          try {
            await sendDocumentRobust(from, mediaId, filename);
            console.log(`background: ${normalizedId} doc sent (flow complete)`);
          } catch (err) {
            logAxiosError(`background ${normalizedId} doc failed`, err);
            // queue doc job with fingerprint
            const id = makeJobId();
            const fingerprint = createMessageFingerprint(from, { media: mediaId }, 'document');
            addJob({ id, type: "doc", to: from, media: mediaId, filename, fingerprint, attempts: 0, maxAttempts: JOB_MAX_RETRIES, nextAttemptAt: Date.now() + JOB_RETRY_BASE_MS, locked: false });
          }
        })();

        return res.status(200).send(`accepted-${normalizedId}`);
      }

      // unknown button
      (async () => { try { await sendTextOnce(from, "Sorry, I didn't recognize that option. Please try again.", TEXT_TIMEOUT_MS); } catch (e) { logAxiosError("unknown-button text", e); } })();
      return res.status(200).send("unknown-button");
    }

    // typed fallback - check all categories
    const typed = (incoming.text || "").trim().toLowerCase();

    // Check each category for typed matches
    const typedMatches = {
      'tv': [TV_BUTTON_TITLE.toLowerCase(), 'tv', 'television'],
      'ac': [AC_BUTTON_TITLE.toLowerCase(), 'ac', 'air conditioner'],
      'refrigerator': [REFRIGERATOR_BUTTON_TITLE.toLowerCase(), 'refrigerator', 'fridge', 'ref'],
      'washing_machine': [WASHING_MACHINE_BUTTON_TITLE.toLowerCase(), 'washing machine', 'washer', 'washing'],
      'kitchen_home': [KITCHEN_HOME_BUTTON_TITLE.toLowerCase(), 'kitchen', 'home', 'kitchen home']
    };

    for (const [categoryId, keywords] of Object.entries(typedMatches)) {
      if (keywords.some(keyword => typed === keyword)) {
        const categoryData = getCategoryData(categoryId);
        if (categoryData) {
          const { mediaId, filename } = categoryData;
          const successMessage = getCategoryMessage(categoryId);

          // Send success message first
          (async () => {
            try {
              await sendTextOnce(from, successMessage, TEXT_TIMEOUT_MS);
              console.log(`typed ${categoryId} success message sent`);
            } catch (err) {
              logAxiosError(`typed ${categoryId} success message failed`, err);
            }
          })();

          // Then send PDF
          (async () => {
            try {
              await sendDocumentRobust(from, mediaId, filename);
              console.log(`typed ${categoryId} doc sent (flow complete)`);
            } catch (err) {
              logAxiosError(`typed ${categoryId} doc failed`, err);
              const id = makeJobId();
              const fingerprint = createMessageFingerprint(from, { media: mediaId }, 'document');
              addJob({ id, type: "doc", to: from, media: mediaId, filename, fingerprint, attempts: 0, maxAttempts: JOB_MAX_RETRIES, nextAttemptAt: Date.now() + JOB_RETRY_BASE_MS, locked: false });
            }
          })();

          return res.status(200).send(`accepted-${categoryId}-typed`);
        }
      }
    }

    // otherwise initial inbound -> send combined intro + interactive buttons (single API call)
    try {
      await sendInteractiveButtons(from);
      console.log("combined intro+interactive sent");
      return res.status(200).send("intro-interactive-sent");
    } catch (errInteractive) {
      logAxiosError("combined intro+interactive failed", errInteractive);
      return res.status(502).send("intro-interactive-send-failed");
    }
  } catch (err) {
    console.error("Unhandled webhook error:", err);
    return res.status(500).send("internal-error");
  }
});

/* -------- START -------- */
app.listen(PORT, () => console.log(`Server listening ${PORT}`));
