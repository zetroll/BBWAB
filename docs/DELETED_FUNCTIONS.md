# Deleted Functions and Historical Code

This document contains all removed functionality with working examples and explanations of why they were deleted.

## Interactive Button System (Removed: 2025-09-18)

### Reason for Removal
The interactive button system was removed in favor of a simpler passive flow to improve user experience and reduce complexity. The multi-choice system caused delays and confusion.

### Last Working Implementation

#### `sendInteractiveButtons(toPhone)`
**Last Location**: `server.js:314-350` (before removal)

```javascript
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
  const combinedText = `${INTRO_TEXT}\\n\\n${INTERACTIVE_BODY}`;

  const payload = {
    body: { text: combinedText },
    action: {
      buttons: [
        { type: "quick_reply", title: TV_BUTTON_TITLE, id: TV_BUTTON_ID },
        { type: "quick_reply", title: AC_BUTTON_TITLE, id: AC_BUTTON_ID },
        { type: "quick_reply", title: REFRIGERATOR_BUTTON_TITLE, id: REFRIGERATOR_BUTTON_ID },
        { type: "quick_reply", title: WASHING_MACHINE_BUTTON_TITLE, id: WASHING_MACHINE_BUTTON_ID }
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
```

**Purpose**: Sent interactive WhatsApp buttons for category selection (TV, AC, Refrigerator, Washing Machine)

#### `extractButtonReply(body)`
**Last Location**: `server.js:500-508` (before removal)

```javascript
function extractButtonReply(body) {
  if (!body) return null;
  const m = (body.messages && body.messages[0]) || body.message || body;
  if (m?.interactive?.button_reply) return { id: m.interactive.button_reply.id, title: m.interactive.button_reply.title };
  if (m?.reply?.buttons_reply) return { id: m.reply.buttons_reply.id, title: m.reply.buttons_reply.title };
  if (m?.reply && (m.reply.id || m.reply.title)) return { id: m.reply.id || null, title: m.reply.title || null };
  return null;
}
```

**Purpose**: Parsed incoming webhook data to extract button click responses

#### `normalizeButtonId(rawId)`
**Last Location**: `server.js:509-513` (before removal)

```javascript
function normalizeButtonId(rawId) {
  if (!rawId) return null;
  const parts = String(rawId).split(":");
  return parts[parts.length - 1].toLowerCase();
}
```

**Purpose**: Normalized button IDs from "ButtonsV3:tv" format to "tv"

### Category-Specific Functions (Removed: 2025-09-18)

#### `getCategoryMessage(categoryId)`
**Last Location**: `server.js:515-525` (before removal)

```javascript
// Category-specific success messages with emojis
function getCategoryMessage(categoryId) {
  const messages = {
    'tv': 'Bada screen aur bhi bada drama! 📺 Yeh raha saare ke saare TV deals – just for you.',
    'ac': 'Kaafi cool choice! ❄️ Yeh rahe best deals on AC – all at ₹100/day*!',
    'refrigerator': 'Serving cool vibes only! 🧊 Saari ki saari cool deals are here!',
    'washing_machine': 'Ab hogi sirf kaapdo ki dhulayi! 🌀 Here are your deals on Washing Machine!'
  };
  return messages[categoryId] || 'Here are your deals!';
}
```

**Purpose**: Returned personalized success messages with emojis for each product category

#### `getCategoryData(categoryId)`
**Last Location**: `server.js:527-535` (before removal)

```javascript
function getCategoryData(categoryId) {
  const categoryMap = {
    'tv': { mediaId: TV_MEDIA_ID, filename: "Dilip's Favourite TVs.pdf" },
    'ac': { mediaId: AC_MEDIA_ID, filename: "Dilip's Favourite ACs.pdf" },
    'refrigerator': { mediaId: REFRIGERATOR_MEDIA_ID, filename: "Dilip's Favourite Refrigerators.pdf" },
    'washing_machine': { mediaId: WASHING_MACHINE_MEDIA_ID, filename: "Dilip's Favourite Washing Machines.pdf" }
  };
  return categoryMap[categoryId];
}
```

**Purpose**: Mapped category IDs to their corresponding media IDs and filenames

### Environment Variables (Removed: 2025-09-18)

#### Category-Specific Variables
```javascript
// TV Category
const TV_BUTTON_TITLE = process.env.TV_BUTTON_TITLE || "TV";
const TV_BUTTON_ID = process.env.TV_BUTTON_ID || "tv";
const TV_MEDIA_ID = process.env.TV_MEDIA_ID || "";

// AC Category
const AC_BUTTON_TITLE = process.env.AC_BUTTON_TITLE || "AC";
const AC_BUTTON_ID = process.env.AC_BUTTON_ID || "ac";
const AC_MEDIA_ID = process.env.AC_MEDIA_ID || "";

// Refrigerator Category
const REFRIGERATOR_BUTTON_TITLE = process.env.REFRIGERATOR_BUTTON_TITLE || "Refrigerator";
const REFRIGERATOR_BUTTON_ID = process.env.REFRIGERATOR_BUTTON_ID || "refrigerator";
const REFRIGERATOR_MEDIA_ID = process.env.REFRIGERATOR_MEDIA_ID || "";

// Washing Machine Category
const WASHING_MACHINE_BUTTON_TITLE = process.env.WASHING_MACHINE_BUTTON_TITLE || "Washing Machine";
const WASHING_MACHINE_BUTTON_ID = process.env.WASHING_MACHINE_BUTTON_ID || "washing_machine";
const WASHING_MACHINE_MEDIA_ID = process.env.WASHING_MACHINE_MEDIA_ID || "";

// Interactive Body Text
const INTERACTIVE_BODY = process.env.INTERACTIVE_BODY || "Choose which category you are interested in:";
```

**Purpose**: Configured individual product categories with separate PDFs and buttons

### Button Detection Logic (Removed: 2025-09-18)

#### Button Click Handler
**Last Location**: `server.js:640-690` (before removal)

```javascript
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
```

**Purpose**: Handled button clicks, sent category-specific messages and PDFs

#### Typed Fallback System
**Last Location**: `server.js:695-740` (before removal)

```javascript
// typed fallback - check all categories
const typed = (incoming.text || "").trim().toLowerCase();

// Check each category for typed matches
const typedMatches = {
  'tv': [TV_BUTTON_TITLE.toLowerCase(), 'tv', 'television'],
  'ac': [AC_BUTTON_TITLE.toLowerCase(), 'ac', 'air conditioner'],
  'refrigerator': [REFRIGERATOR_BUTTON_TITLE.toLowerCase(), 'refrigerator', 'fridge', 'ref'],
  'washing_machine': [WASHING_MACHINE_BUTTON_TITLE.toLowerCase(), 'washing machine', 'washer', 'washing']
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
```

**Purpose**: Allowed users to type category names instead of clicking buttons

## URL Shortening System (Removed: 2025-09-18)

### Reason for Removal
URL shortening was removed when we switched to PDF-only delivery. The complex URL optimization was no longer needed.

### Last Working Implementation

#### `shortenUrlIfLong(url, threshold)`
**Last Location**: `server.js:220-240` (before removal)

```javascript
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
```

**Purpose**: Shortened long URLs using TinyURL API to improve WHAPI performance

#### `sendTextRobustOrQueue(toPhone, body)`
**Last Location**: `server.js:580-620` (before removal)

```javascript
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
```

**Purpose**: Sent text messages with URL optimization and retry logic

## High TPS Rate Limiting (Removed: 2025-09-18)

### Reason for Removal
Replaced with WHAPI-compliant 2 messages per minute rate limiting to prevent account bans.

### Last Working Implementation

```javascript
// Rate limiting for 5 TPS max
const RATE_LIMIT_TPS = parseInt(process.env.RATE_LIMIT_TPS || "5", 10);
const rateLimitWindow = new LRU({ max: 1000, ttl: 1000 }); // 1 second windows

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
```

**Purpose**: Prevented excessive API calls but was too aggressive for WHAPI compliance

## Link Sending Logic (Removed: 2025-09-18)

### Reason for Removal
Link sending caused frequent timeouts and duplicates due to WHAPI's poor handling of long URLs. Replaced with PDF-only delivery.

### Last Working Implementation

#### Environment Variables
```javascript
const TV_LINK = process.env.TV_LINK || "";
const AC_LINK = process.env.AC_LINK || "";
```

#### Link Sending Calls
```javascript
// In button handler
(async () => {
  try { await sendTextRobustOrQueue(from, TV_LINK); } catch (err) { logAxiosError("sendTextRobustOrQueue (tv) fatal", err); }
})();

// In AC handler
(async () => {
  try { await sendTextRobustOrQueue(from, AC_LINK); } catch (err) { logAxiosError("sendTextRobustOrQueue (ac) fatal", err); }
})();
```

**Purpose**: Sent product links after PDF delivery, but caused performance issues

## Admin Endpoints (Removed: 2025-09-18)

### Reason for Removal
Administrative endpoints were removed to simplify the system and reduce attack surface.

### Last Working Implementation

#### `POST /admin/send-doc`
**Last Location**: `server.js:367-383` (before removal)

```javascript
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
```

**Purpose**: Manual document sending for testing

#### `GET /admin/failed-jobs`
**Last Location**: `server.js:385-392` (before removal)

```javascript
app.get("/admin/failed-jobs", (req, res) => {
  if (ADMIN_KEY) {
    const key = req.headers["x-admin-key"];
    if (!key || key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "invalid admin key" });
  }
  const list = Array.from(jobs.values()).map((j) => ({ id: j.id, type: j.type, to: j.to, attempts: j.attempts, nextAttemptAt: j.nextAttemptAt }));
  return res.json({ ok: true, queued: list });
});
```

**Purpose**: Job queue inspection for debugging

#### `POST /admin/retry-job`
**Last Location**: `server.js:394-407` (before removal)

```javascript
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
```

**Purpose**: Manual job retry for stuck jobs

## Configuration Changes

### Old Rate Limiting Configuration
```javascript
const TEXT_IMMEDIATE_TRIES = parseInt(process.env.TEXT_IMMEDIATE_TRIES || "2", 10);
const JOB_MAX_RETRIES = parseInt(process.env.JOB_MAX_RETRIES || "5", 10);
const TEXT_TIMEOUT_MS = parseInt(process.env.TEXT_TIMEOUT_MS || "5000", 10);
```

### Old Cache Configuration
```javascript
const SENT_CACHE_TTL_MS = parseInt(process.env.SENT_CACHE_TTL_MS || String(10 * 60 * 1000), 10);
```

### Old Validation Logic
```javascript
if (!TV_LINK || !TV_MEDIA_ID || !AC_LINK || !AC_MEDIA_ID) {
  console.error("Missing one of TV/AC link or media env vars - aborting.");
  process.exit(1);
}
```

## Key Lessons from Removed Code

### Why Interactive Buttons Failed
1. **User Confusion**: Too many choices overwhelmed users
2. **Timing Issues**: Button rendering vs text message ordering
3. **Complexity**: Multiple code paths increased bugs
4. **Performance**: Additional API calls slowed response

### Why URL Sending Failed
1. **WHAPI Limitations**: Poor handling of long URLs (>100 chars)
2. **Timeout Cascades**: 8-30 second delays were unacceptable
3. **Phantom Deliveries**: Failed requests delivered later causing duplicates
4. **Link Preview Processing**: WHAPI processed previews slowly

### Why High TPS Failed
1. **Ban Risk**: 5 TPS exceeded WHAPI's recommended 2 per minute
2. **Unnatural Pattern**: Constant high throughput appeared bot-like
3. **Resource Waste**: Many requests weren't critical

### Migration Strategy Applied
1. **Simplification**: Removed all choice logic
2. **Single Path**: One message type, one PDF, one flow
3. **Anti-Ban Focus**: Implemented WHAPI guidelines strictly
4. **Natural Timing**: Random delays and greetings
5. **State Management**: Prevented duplicate contacts

These deletions represent significant functionality that was working but incompatible with:
- WHAPI's performance characteristics
- WhatsApp's anti-spam detection
- User experience requirements
- System reliability goals

The current simplified system achieves better performance and compliance by doing less, but doing it reliably.