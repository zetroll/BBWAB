# Function Reference

## Core Functions

### Configuration and Setup

#### Environment Variables
**Location**: `server.js:27-85`

```javascript
const SEND_API_KEY = process.env.SEND_API_KEY;
const COMBINED_MEDIA_ID = process.env.COMBINED_MEDIA_ID || "";
const COMBINED_FILENAME = process.env.COMBINED_FILENAME || "Dilip's Favourite Products.pdf";
```

**Critical Variables**:
- `SEND_API_KEY` - WHAPI authentication token
- `COMBINED_MEDIA_ID` - PDF media ID from WHAPI upload
- `TEXT_TIMEOUT_MS` - API timeout (default: 8000ms)
- `JOB_MAX_RETRIES` - Maximum retry attempts (default: 2)

### Request Tracing and Analytics

#### `createRequestTrace(type, to, payload)`
**Location**: `server.js:120-130`

Creates unique trace ID for request monitoring.

```javascript
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
```

**Parameters**:
- `type` - Request type ('text', 'doc-json', 'doc-multipart', 'interactive')
- `to` - Recipient phone number
- `payload` - Request payload for hashing

**Returns**: Trace object with unique ID and metadata

#### `analyzeWhapiResponse(trace, response, error)`
**Location**: `server.js:140-165`

Analyzes WHAPI API responses for debugging and monitoring.

```javascript
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
    responseData: JSON.stringify(response?.data || {}).slice(0, 400)
  };

  console.log(`TRACE ${trace.id}: ${trace.type} ${analysis.timing}`, analysis);
  return analysis;
}
```

**Critical for**: Debugging API issues, performance monitoring, preview detection

### Anti-Ban System

#### `checkRateLimit()`
**Location**: `server.js:167-178`

Enforces WHAPI's 2 messages per minute rate limit.

```javascript
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
```

**⚠️ CRITICAL**: Do not modify without understanding WHAPI ban consequences

#### `getRandomDelay()`
**Location**: `server.js:180-184`

Generates natural timing delays for anti-ban compliance.

```javascript
function getRandomDelay() {
  // Minimum 2 seconds, maximum 10 seconds, with millisecond variation
  return Math.max(2000, Math.floor(Math.random() * 10000) + Math.random() * 1000);
}
```

**Returns**: Random delay between 2000-11000ms

#### `getRandomGreeting()`
**Location**: `server.js:186-191`

Selects random greeting from bank for natural conversation.

```javascript
function getRandomGreeting() {
  // 30% chance of no greeting, 70% chance of random greeting
  if (Math.random() < 0.3) return "";
  const greetings = greetingBank.slice(1); // Exclude empty string
  return greetings[Math.floor(Math.random() * greetings.length)];
}
```

**Greeting Bank**: `["Hi", "Hello", "Namaste", "Hello friend", "Hi dost", "Namaste friend", "Hii", "Hi!", "Hi dost!", "Hello!"]`

### User State Management

#### `hasUserBeenContacted(phoneNumber)`
**Location**: `server.js:197-201`

Checks if user has been previously contacted.

```javascript
function hasUserBeenContacted(phoneNumber) {
  const userKey = normalizePhone(phoneNumber);
  return userInteractionCache.has(userKey);
}
```

**Critical for**: Preventing spam, maintaining one-contact policy

#### `markUserContacted(phoneNumber, interactionType)`
**Location**: `server.js:203-220`

Updates user interaction state with TTL tracking.

```javascript
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
```

**Interaction Types**: `'initial'`, `'followup'`

### Message Queue System

#### `queueMessage(phoneNumber, messageType, data)`
**Location**: `server.js:225-240`

Adds messages to delayed processing queue.

```javascript
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
```

**Message Types**: `'greeting_and_pdf'`, `'emoji_response'`

#### `processMessageQueue()`
**Location**: `server.js:242-265`

Background processor for queued messages (runs every 1000ms).

```javascript
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
```

**⚠️ CRITICAL**: Do not modify queue processing logic

### WHAPI API Integration

#### `sendTextOnce(toPhone, body, timeoutMs)`
**Location**: `server.js:350-385`

Sends single text message with comprehensive tracking.

```javascript
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
```

**Key Features**:
- Request tracing
- Duplicate prevention
- Rate limiting
- Phantom delivery tracking

#### `sendDocumentJsonOnce(toPhone, mediaId, filename, timeoutMs)`
**Location**: `server.js:387-420`

Sends document using JSON payload (primary method).

```javascript
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
```

#### `sendDocumentRobust(toPhone, mediaId, filename)`
**Location**: `server.js:470-520`

Robust document sender with JSON → multipart fallback.

```javascript
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
```

### Utility Functions

#### `normalizePhone(raw)`
**Location**: `server.js:95-107`

Standardizes phone number format for consistent storage.

```javascript
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
```

**⚠️ CRITICAL**: Phone normalization affects all user tracking

#### `logAxiosError(tag, err)`
**Location**: `server.js:74-93`

Comprehensive error logging for API failures.

```javascript
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
```

## Admin Functions

### Testing Endpoints

#### `POST /test-url`
**Location**: `server.js:175-210`

Development endpoint for URL testing with optional shortening.

```javascript
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
```

## Function Dependencies

### Critical Dependencies
- `crypto` - UUID generation, hashing
- `axios` - HTTP client for WHAPI
- `lru-cache` - Memory management
- `express` - Web framework
- `body-parser` - Request parsing

### Internal Dependencies
```
normalizePhone() ← hasUserBeenContacted() ← webhook handler
createRequestTrace() ← all WHAPI functions
checkRateLimit() ← all outbound functions
analyzeWhapiResponse() ← all WHAPI functions
```

## Performance Considerations

### Memory Usage by Function
- `userInteractionCache`: O(n) where n = unique users
- `messageQueue`: O(m) where m = pending messages
- `sentCache`: O(k) where k = recent sends
- `outboundMessageCache`: O(j) where j = tracked messages

### CPU Intensive Functions
- `processMessageQueue()`: Runs every 1000ms
- `createMessageFingerprint()`: Crypto operations
- `normalizePhone()`: String processing
- `analyzeWhapiResponse()`: JSON serialization

### Network Dependent Functions
- All `send*()` functions depend on WHAPI availability
- Timeout handling critical for user experience
- Retry logic prevents cascade failures