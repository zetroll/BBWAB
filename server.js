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
const COMBINED_MEDIA_ID = process.env.COMBINED_MEDIA_ID || "";
const COMBINED_FILENAME = process.env.COMBINED_FILENAME || "Dilip's Favourite Products.pdf";

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

// Anti-ban rate limiting (WHAPI guidelines: max 2 messages per minute)
const RATE_LIMIT_PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE || "2", 10);
const rateLimitWindow = new LRU({ max: 1000, ttl: 60000 }); // 1 minute windows

// User interaction tracking for anti-ban measures
const userInteractionCache = new LRU({ max: 10000, ttl: 7 * 24 * 60 * 60 * 1000 }); // 7 days
const outboundMessageCache = new LRU({ max: 10000, ttl: PHANTOM_DELIVERY_WINDOW_MS });

// Queue for delayed message sending (anti-ban timing)
const messageQueue = [];
const processingQueue = new Set();

// Greeting variations for natural behavior
const greetingBank = [
  "", // No greeting (30% chance)
  "Hi",
  "Hello",
  "Namaste",
  "Hello friend",
  "Hi dost",
  "Namaste friend",
  "Hii",
  "Hi!",
  "Hi dost!",
  "Hello!"
];

// Emoji responses for follow-ups
const emojiResponses = ["✅", "😊", "👍", "🙏", "😄", "👌"];

if (!SEND_API_KEY) {
  console.error("Missing SEND_API_KEY - aborting.");
  process.exit(1);
}
if (!COMBINED_MEDIA_ID) {
  console.error("Missing COMBINED_MEDIA_ID - aborting.");
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
  const currentMinute = Math.floor(now / 60000);
  const currentCount = rateLimitWindow.get(currentMinute) || 0;

  if (currentCount >= RATE_LIMIT_PER_MINUTE) {
    console.warn(`Rate limit exceeded: ${currentCount}/${RATE_LIMIT_PER_MINUTE} per minute`);
    return false;
  }

  rateLimitWindow.set(currentMinute, currentCount + 1);
  return true;
}

function getRandomDelay() {
  // Minimum 2 seconds, maximum 10 seconds, with millisecond variation
  return Math.max(2000, Math.floor(Math.random() * 10000) + Math.random() * 1000);
}

function getRandomGreeting() {
  // 30% chance of no greeting, 70% chance of random greeting
  if (Math.random() < 0.3) return "";
  const greetings = greetingBank.slice(1); // Exclude empty string
  return greetings[Math.floor(Math.random() * greetings.length)];
}

function shouldSendDirectPDF() {
  // 5% chance to send PDF directly with greeting
  return Math.random() < 0.05;
}

function hasUserBeenContacted(phoneNumber) {
  const userKey = normalizePhone(phoneNumber);
  return userInteractionCache.has(userKey);
}

function markUserContacted(phoneNumber, interactionType = 'initial') {
  const userKey = normalizePhone(phoneNumber);
  const userData = userInteractionCache.get(userKey) || {
    firstContact: Date.now(),
    interactions: [],
    sentInitial: false,
    sentFollowUp: false
  };

  userData.interactions.push({ type: interactionType, timestamp: Date.now() });
  if (interactionType === 'initial') userData.sentInitial = true;
  if (interactionType === 'followup') userData.sentFollowUp = true;

  userInteractionCache.set(userKey, userData);
  return userData;
}

function getRandomEmoji() {
  return emojiResponses[Math.floor(Math.random() * emojiResponses.length)];
}

async function queueMessage(phoneNumber, messageType, data) {
  const delay = getRandomDelay();
  const executeAt = Date.now() + delay;

  const queueItem = {
    id: crypto.randomUUID(),
    phoneNumber,
    messageType,
    data,
    executeAt,
    attempts: 0
  };

  messageQueue.push(queueItem);
  console.log(`Queued ${messageType} for ${phoneNumber} in ${delay}ms`);

  // Sort queue by execution time
  messageQueue.sort((a, b) => a.executeAt - b.executeAt);
}

async function processMessageQueue() {
  const now = Date.now();
  const readyMessages = messageQueue.filter(msg => msg.executeAt <= now && !processingQueue.has(msg.id));

  for (const msg of readyMessages) {
    if (!checkRateLimit()) {
      console.log('Rate limit hit, delaying queue processing');
      break;
    }

    processingQueue.add(msg.id);
    const index = messageQueue.findIndex(m => m.id === msg.id);
    if (index > -1) messageQueue.splice(index, 1);

    try {
      await executeQueuedMessage(msg);
    } catch (error) {
      console.error(`Failed to execute queued message ${msg.id}:`, error.message);
    } finally {
      processingQueue.delete(msg.id);
    }
  }
}

async function executeQueuedMessage(msg) {
  const { phoneNumber, messageType, data } = msg;

  switch (messageType) {
    case 'greeting_and_pdf':
      await sendGreetingAndPDF(phoneNumber, data.greeting, data.directPDF);
      break;
    case 'emoji_response':
      await sendTextOnce(phoneNumber, data.emoji, TEXT_TIMEOUT_MS);
      console.log(`Sent emoji response to ${phoneNumber}`);
      break;
    default:
      console.warn(`Unknown message type: ${messageType}`);
  }
}

async function sendGreetingAndPDF(phoneNumber, greeting, directPDF) {
  try {
    if (directPDF) {
      // Send PDF with greeting as caption (5% of cases)
      const payload = {
        to: String(phoneNumber),
        media: String(COMBINED_MEDIA_ID),
        filename: COMBINED_FILENAME,
        caption: greeting || INTRO_TEXT,
        type: "document"
      };

      const headers = {
        Authorization: `Bearer ${SEND_API_KEY}`,
        "Content-Type": "application/json",
        "X-Request-Id": crypto.randomUUID()
      };

      await axios.post(SEND_DOC_URL, payload, { headers, timeout: DOC_TIMEOUT_MS });
      console.log(`Sent direct PDF with greeting to ${phoneNumber}`);
    } else {
      // Send greeting first, then PDF
      if (greeting) {
        const fullMessage = `${greeting} ${INTRO_TEXT}`.trim();
        await sendTextOnce(phoneNumber, fullMessage, TEXT_TIMEOUT_MS);

        // Small delay before PDF
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
      }

      await sendDocumentRobust(phoneNumber, COMBINED_MEDIA_ID, COMBINED_FILENAME);
      console.log(`Sent greeting + PDF to ${phoneNumber}`);
    }

    markUserContacted(phoneNumber, 'initial');
  } catch (error) {
    console.error(`Failed to send greeting and PDF to ${phoneNumber}:`, error.message);
    throw error;
  }
}

/* -------- DEDUPE & SENT CACHE -------- */
const dedupe = new LRU({ max: MAX_DEDUPE_ENTRIES, ttl: DEDUPE_TTL_MS });

// Sent cache prevents duplicate API calls for same to+payload within TTL.
// Reduced TTL - allow same user to get same content multiple times per session
const SENT_CACHE_TTL_MS = parseInt(process.env.SENT_CACHE_TTL_MS || "30000", 10); // 30 seconds only
const sentCache = new LRU({ max: 20000, ttl: SENT_CACHE_TTL_MS });

app.get("/health", (req, res) => res.json({ ok: true }));

// Start queue processor
setInterval(processMessageQueue, 1000); // Check every second

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

    // Check if user has already been contacted
    if (hasUserBeenContacted(from)) {
      const userData = userInteractionCache.get(normalizePhone(from));

      // If user responds after initial contact, send emoji once
      if (userData.sentInitial && !userData.sentFollowUp) {
        console.log(`User ${from} responded - queueing emoji response`);
        await queueMessage(from, 'emoji_response', { emoji: getRandomEmoji() });
        markUserContacted(from, 'followup');
        return res.status(200).send("emoji-queued");
      } else {
        console.log(`User ${from} already contacted - ignoring`);
        return res.status(200).send("already-contacted");
      }
    }

    // New user - queue initial contact with anti-ban measures
    console.log(`New user ${from} - queueing initial contact`);

    const greeting = getRandomGreeting();
    const directPDF = shouldSendDirectPDF();

    await queueMessage(from, 'greeting_and_pdf', {
      greeting,
      directPDF
    });

    console.log(`Queued ${directPDF ? 'direct PDF' : 'greeting + PDF'} for ${from}`);
    return res.status(200).send("contact-queued");
  } catch (err) {
    console.error("Unhandled webhook error:", err);
    return res.status(500).send("internal-error");
  }
});

/* -------- START -------- */
app.listen(PORT, () => console.log(`Server listening ${PORT}`));
