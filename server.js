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
const TV_LINK = process.env.TV_LINK || "";
const TV_MEDIA_ID = process.env.TV_MEDIA_ID || "";
const AC_BUTTON_TITLE = process.env.AC_BUTTON_TITLE || "AC";
const AC_BUTTON_ID = process.env.AC_BUTTON_ID || "ac";
const AC_LINK = process.env.AC_LINK || "";
const AC_MEDIA_ID = process.env.AC_MEDIA_ID || "";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || null;
const SENDER_PHONE = process.env.SENDER_PHONE || null;

const TEXT_TIMEOUT_MS = parseInt(process.env.TEXT_TIMEOUT_MS || "5000", 10); // slightly higher to reduce false timeouts
const TEXT_IMMEDIATE_TRIES = parseInt(process.env.TEXT_IMMEDIATE_TRIES || "2", 10);
const DOC_TIMEOUT_MS = parseInt(process.env.DOC_TIMEOUT_MS || "30000", 10);
const DOC_RETRIES = parseInt(process.env.DOC_RETRIES || "1", 10);

const JOB_MAX_RETRIES = parseInt(process.env.JOB_MAX_RETRIES || "5", 10);
const JOB_RETRY_BASE_MS = parseInt(process.env.JOB_RETRY_BASE_MS || "2000", 10);
const ADMIN_KEY = process.env.ADMIN_KEY || null;

const DEDUPE_TTL_MIN = parseInt(process.env.DEDUPE_TTL_MIN || "5", 10);
const DEDUPE_TTL_MS = DEDUPE_TTL_MIN * 60 * 1000;
const MAX_DEDUPE_ENTRIES = parseInt(process.env.MAX_DEDUPE_ENTRIES || "10000", 10);

if (!SEND_API_KEY) {
  console.error("Missing SEND_API_KEY - aborting.");
  process.exit(1);
}
if (!TV_LINK || !TV_MEDIA_ID || !AC_LINK || !AC_MEDIA_ID) {
  console.error("Missing one of TV/AC link or media env vars - aborting.");
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

/* small hashing helper for sentCache key */
function sha256hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/* -------- DEDUPE & SENT CACHE -------- */
const dedupe = new LRU({ max: MAX_DEDUPE_ENTRIES, ttl: DEDUPE_TTL_MS });

// Sent cache prevents duplicate API calls for same to+payload within short TTL.
// TTL: 10 minutes by default (tunable)
const SENT_CACHE_TTL_MS = parseInt(process.env.SENT_CACHE_TTL_MS || String(10 * 60 * 1000), 10);
const sentCache = new LRU({ max: 20000, ttl: SENT_CACHE_TTL_MS });

app.get("/health", (req, res) => res.json({ ok: true }));

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
      // Idempotency check: if an equivalent message was already sent, skip and remove job
      const key = job.type === "doc" ? `doc:${job.to}:${job.media}` : `text:${job.to}:${job.body}`;
      if (sentCache.get(key)) {
        console.log(`Job ${job.id} skipped - already sent (sentCache)`);
        jobs.delete(job.id);
        continue;
      }

      if (job.type === "doc") {
        await sendDocumentRobust(job.to, job.media, job.filename);
        console.log("Job success doc", job.id);
        // mark sent (prevents duplicate sends)
        sentCache.set(key, true);
        jobs.delete(job.id);
      } else if (job.type === "text") {
        await sendTextOnce(job.to, job.body, TEXT_TIMEOUT_MS);
        console.log("Job success text", job.id);
        sentCache.set(key, true);
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
  // idempotency: check sentCache before sending and mark after success
  const key = `text:${toPhone}:${body}`;
  if (sentCache.get(key)) {
    console.log("sendTextOnce: skipped (already sent according to cache)", toPhone);
    return { skipped: true };
  }
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, "Content-Type": "application/json" };
  const payload = { to: String(toPhone), body: String(body) };
  const resp = await axios.post(SEND_TEXT_URL, payload, { headers, timeout: timeoutMs });
  // success -> mark sent
  sentCache.set(key, true);
  return resp;
}

async function sendDocumentJsonOnce(toPhone, mediaId, filename, timeoutMs) {
  const key = `doc:${toPhone}:${mediaId}`;
  if (sentCache.get(key)) {
    console.log("sendDocumentJsonOnce: skipped (already sent)", toPhone, mediaId);
    return { skipped: true };
  }
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, "Content-Type": "application/json" };
  const payload = { to: String(toPhone), media: String(mediaId), filename: filename ? String(filename) : undefined, type: "document" };
  const resp = await axios.post(SEND_DOC_URL, payload, { headers, timeout: timeoutMs });
  sentCache.set(key, true);
  return resp;
}

async function sendDocumentMultipartOnce(toPhone, mediaId, filename, timeoutMs) {
  const key = `doc:${toPhone}:${mediaId}`;
  if (sentCache.get(key)) {
    console.log("sendDocumentMultipartOnce: skipped (already sent)", toPhone, mediaId);
    return { skipped: true };
  }
  const form = new FormData();
  form.append("to", String(toPhone));
  form.append("media", String(mediaId));
  if (filename) form.append("filename", String(filename));
  form.append("type", "document");
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, ...form.getHeaders() };
  const resp = await axios.post(SEND_DOC_URL, form, { headers, timeout: timeoutMs, maxContentLength: Infinity, maxBodyLength: Infinity });
  sentCache.set(key, true);
  return resp;
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

/* sendTextRobustOrQueue: quick immediate tries, then queue */
async function sendTextRobustOrQueue(toPhone, body) {
  const key = `text:${toPhone}:${body}`;
  if (sentCache.get(key)) {
    console.log("sendTextRobustOrQueue: already sent (cache) - skipping");
    return null;
  }

  for (let i = 0; i < TEXT_IMMEDIATE_TRIES; i++) {
    try {
      console.log(`sendTextRobustOrQueue: quick try ${i + 1} to ${toPhone}`);
      const r = await sendTextOnce(toPhone, body, TEXT_TIMEOUT_MS);
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

  // enqueue job for retries
  const jobId = makeJobId();
  const job = {
    id: jobId,
    type: "text",
    to: toPhone,
    body,
    attempts: 0,
    maxAttempts: JOB_MAX_RETRIES,
    nextAttemptAt: Date.now() + JOB_RETRY_BASE_MS,
    locked: false
  };
  addJob(job);
  console.log("text send queued as job", jobId);
  return null;
}

/* interactive send */
async function sendInteractiveButtons(toPhone) {
  const headers = { Authorization: `Bearer ${SEND_API_KEY}`, "Content-Type": "application/json" };
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
  return axios.post(SEND_INTERACTIVE_URL, payload, { headers, timeout: TEXT_TIMEOUT_MS });
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

      // pick assets
      if (normalizedId === (TV_BUTTON_ID || "tv").toLowerCase()) {
        const filename = "Dilip's Favourite TVs.pdf";

        // Document-first background (non-blocking)
        (async () => {
          try {
            await sendDocumentRobust(from, TV_MEDIA_ID, filename);
            console.log("background: TV doc sent");
          } catch (err) {
            logAxiosError("background TV doc failed", err);
            // queue doc job
            const id = makeJobId();
            addJob({ id, type: "doc", to: from, media: TV_MEDIA_ID, filename, attempts: 0, maxAttempts: JOB_MAX_RETRIES, nextAttemptAt: Date.now() + JOB_RETRY_BASE_MS, locked: false });
          }
        })();

        // text tries + fallback queue
        (async () => {
          try { await sendTextRobustOrQueue(from, TV_LINK); } catch (err) { logAxiosError("sendTextRobustOrQueue (tv) fatal", err); }
        })();

        return res.status(200).send("accepted-tv");
      }

      if (normalizedId === (AC_BUTTON_ID || "ac").toLowerCase()) {
        const filename = "Dilip's Favourite ACs.pdf";

        (async () => {
          try {
            await sendDocumentRobust(from, AC_MEDIA_ID, filename);
            console.log("background: AC doc sent");
          } catch (err) {
            logAxiosError("background AC doc failed", err);
            const id = makeJobId();
            addJob({ id, type: "doc", to: from, media: AC_MEDIA_ID, filename, attempts: 0, maxAttempts: JOB_MAX_RETRIES, nextAttemptAt: Date.now() + JOB_RETRY_BASE_MS, locked: false });
          }
        })();

        (async () => {
          try { await sendTextRobustOrQueue(from, AC_LINK); } catch (err) { logAxiosError("sendTextRobustOrQueue (ac) fatal", err); }
        })();

        return res.status(200).send("accepted-ac");
      }

      // unknown button
      (async () => { try { await sendTextOnce(from, "Sorry, I didn't recognize that option. Please try again.", TEXT_TIMEOUT_MS); } catch (e) { logAxiosError("unknown-button text", e); } })();
      return res.status(200).send("unknown-button");
    }

    // typed fallback
    const typed = (incoming.text || "").trim().toLowerCase();
    if (typed === TV_BUTTON_TITLE.toLowerCase() || typed === "tv") {
      const filename = "Dilip's Favourite TVs.pdf";
      (async () => {
        try { await sendDocumentRobust(from, TV_MEDIA_ID, filename); } catch (err) { logAxiosError("typed TV doc failed", err); const id = makeJobId(); addJob({ id, type: "doc", to: from, media: TV_MEDIA_ID, filename, attempts: 0, maxAttempts: JOB_MAX_RETRIES, nextAttemptAt: Date.now() + JOB_RETRY_BASE_MS, locked: false }); }
      })();
      (async () => { try { await sendTextRobustOrQueue(from, TV_LINK); } catch (err) { logAxiosError("typed TV text fatal", err); } })();
      return res.status(200).send("accepted-tv-typed");
    }
    if (typed === AC_BUTTON_TITLE.toLowerCase() || typed === "ac") {
      const filename = "Dilip's Favourite ACs.pdf";
      (async () => {
        try { await sendDocumentRobust(from, AC_MEDIA_ID, filename); } catch (err) { logAxiosError("typed AC doc failed", err); const id = makeJobId(); addJob({ id, type: "doc", to: from, media: AC_MEDIA_ID, filename, attempts: 0, maxAttempts: JOB_MAX_RETRIES, nextAttemptAt: Date.now() + JOB_RETRY_BASE_MS, locked: false }); }
      })();
      (async () => { try { await sendTextRobustOrQueue(from, AC_LINK); } catch (err) { logAxiosError("typed AC text fatal", err); } })();
      return res.status(200).send("accepted-ac-typed");
    }

    // otherwise initial inbound -> intro + interactive (best-effort)
    (async () => { try { await sendTextOnce(from, INTRO_TEXT, TEXT_TIMEOUT_MS); } catch (errIntro) { logAxiosError("intro text failed", errIntro); } })();
    try {
      await sendInteractiveButtons(from);
      console.log("interactive sent");
      return res.status(200).send("interactive-sent");
    } catch (errInteractive) {
      logAxiosError("interactive failed", errInteractive);
      return res.status(502).send("interactive-send-failed");
    }
  } catch (err) {
    console.error("Unhandled webhook error:", err);
    return res.status(500).send("internal-error");
  }
});

/* -------- START -------- */
app.listen(PORT, () => console.log(`Server listening ${PORT}`));
