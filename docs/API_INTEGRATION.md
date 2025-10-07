# WHAPI Integration Guide

## Overview

This document provides comprehensive details about the WHAPI.cloud integration, including API endpoints, authentication, error handling, and best practices.

## WHAPI.cloud API Endpoints

### Base Configuration
```javascript
const SEND_TEXT_URL = "https://gate.whapi.cloud/messages/text";
const SEND_DOC_URL = "https://gate.whapi.cloud/messages/document";
const SEND_INTERACTIVE_URL = "https://gate.whapi.cloud/messages/interactive"; // Legacy
```

### Authentication
**Method**: Bearer Token Authentication
**Header**: `Authorization: Bearer {SEND_API_KEY}`
**Token Format**: Alphanumeric string (~32 characters)
**Example**: `QoFrXzOQxjr1hO7tO2V7TYUPF05T5794`

## API Endpoint Details

### 1. POST /messages/text

#### Purpose
Send text messages to WhatsApp users

#### Implementation
**Location**: `server.js:350-385`

```javascript
async function sendTextOnce(toPhone, body, timeoutMs) {
  const trace = createRequestTrace('text', toPhone, { body });
  const fingerprint = createMessageFingerprint(toPhone, body, 'text');

  const headers = {
    Authorization: `Bearer ${SEND_API_KEY}`,
    "Content-Type": "application/json",
    "X-Request-Id": trace.id
  };

  const payload = {
    to: String(toPhone),
    body: String(body)
  };

  const resp = await axios.post(SEND_TEXT_URL, payload, {
    headers,
    timeout: timeoutMs
  });

  return resp;
}
```

#### Request Format
```json
{
  "to": "919071719533",
  "body": "Hi, I'm Dileep, and I want to share my favourite products with you!"
}
```

#### Response Format
```json
{
  "sent": true,
  "message": {
    "id": "PspLNn0niitC3Co-wJbV_PGAbQ",
    "from_me": true,
    "type": "text",
    "chat_id": "919071719533@s.whatsapp.net",
    "timestamp": 1758176212,
    "source": "api",
    "device_id": 1,
    "status": "pending",
    "text": {
      "body": "Hi, I'm Dileep, and I want to share my favourite products with you!"
    },
    "from": "917490034049"
  }
}
```

#### Performance Characteristics
- **Typical Response Time**: 500-2000ms
- **With Long URLs**: 8000-30000ms (problematic)
- **Timeout Recommendation**: 8000ms
- **Rate Limit**: 2 messages per minute

### 2. POST /messages/document

#### Purpose
Send document/PDF files to WhatsApp users

#### Implementation
**Location**: `server.js:387-420`

```javascript
async function sendDocumentJsonOnce(toPhone, mediaId, filename, timeoutMs) {
  const trace = createRequestTrace('doc-json', toPhone, { media: mediaId, filename });

  const headers = {
    Authorization: `Bearer ${SEND_API_KEY}`,
    "Content-Type": "application/json",
    "X-Request-Id": trace.id
  };

  const payload = {
    to: String(toPhone),
    media: String(mediaId),
    filename: filename ? String(filename) : undefined,
    type: "document"
  };

  const resp = await axios.post(SEND_DOC_URL, payload, {
    headers,
    timeout: timeoutMs
  });

  return resp;
}
```

#### Request Format (JSON)
```json
{
  "to": "919071719533",
  "media": "pdf-3eca2ab696205ded438514-c027d5fcf1806d",
  "filename": "Dilip's Favourite Products.pdf",
  "type": "document"
}
```

#### Request Format (Multipart - Fallback)
```javascript
const form = new FormData();
form.append("to", String(toPhone));
form.append("media", String(mediaId));
form.append("filename", String(filename));
form.append("type", "document");

const headers = {
  Authorization: `Bearer ${SEND_API_KEY}`,
  "X-Request-Id": trace.id,
  ...form.getHeaders()
};
```

#### Response Format
```json
{
  "sent": true,
  "message": {
    "id": "PsoqtpYgXe1DhRQ-wCfV_PGAbQ",
    "from_me": true,
    "type": "document",
    "chat_id": "919071719533@s.whatsapp.net",
    "timestamp": 1758176524,
    "source": "api",
    "device_id": 1,
    "status": "pending",
    "document": {
      "id": "pdf-3eca2ab696205ded438514-c027d5fcf1806d",
      "mime_type": "application/pdf",
      "file_size": 1312229,
      "sha256": "/u0a6vPIFpjmhacBEmt+FfwMbwiSAcaGSMw7w74kfvs=",
      "file_name": "Dilip's Favourite Products.pdf"
    }
  }
}
```

#### Performance Characteristics
- **Typical Response Time**: 1900-3750ms
- **Timeout Recommendation**: 30000ms
- **Rate Limit**: 2 messages per minute
- **File Size Limit**: 100MB
- **Supported Formats**: PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX

#### Robust Document Sending
**Location**: `server.js:470-520`

The system implements a robust document sending strategy:

1. **Primary Method**: JSON payload (faster)
2. **Fallback Method**: Multipart form-data
3. **Retry Logic**: Exponential backoff
4. **Error Handling**: Different strategies for different error types

```javascript
async function sendDocumentRobust(toPhone, mediaId, filename) {
  for (let attempt = 0; attempt <= DOC_RETRIES; attempt++) {
    try {
      // Try JSON method first
      const r = await sendDocumentJsonOnce(toPhone, mediaId, filename, DOC_TIMEOUT_MS);
      return r;
    } catch (errJson) {
      // If JSON fails, try multipart
      try {
        const r2 = await sendDocumentMultipartOnce(toPhone, mediaId, filename, DOC_TIMEOUT_MS);
        return r2;
      } catch (errMulti) {
        // Both methods failed, retry with backoff
        if (attempt < DOC_RETRIES) {
          const backoff = 1000 * Math.pow(2, attempt);
          await sleep(backoff);
        }
      }
    }
  }
  throw new Error("Document send exhausted attempts");
}
```

## Media Upload Integration

### PDF Upload Process
**File**: `preupload.js`

```javascript
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

async function uploadPDF() {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(PDF_PATH));

  const headers = {
    ...formData.getHeaders(),
    'Authorization': `Bearer ${UPLOAD_API_KEY}`
  };

  const resp = await axios.post(UPLOAD_URL, formData, {
    headers,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 60000
  });

  const mediaId = resp.data?.media_id || resp.data?.id || resp.data?.data?.id;
  console.log('MEDIA_ID:', mediaId);
}
```

### Media ID Format
**Valid Format**: `pdf-{hash1}-{hash2}`
**Example**: `pdf-3eca2ab696205ded438514-c027d5fcf1806d`
**Usage**: Reference uploaded files in document API calls

## Webhook Integration

### Webhook URL Configuration
**Endpoint**: `https://your-app.railway.app/webhook`
**Method**: POST
**Content-Type**: `application/json`

### Webhook Security
```javascript
// Optional webhook verification
if (VERIFY_TOKEN) {
  const token = req.headers["x-whapi-token"] || req.headers["x-webhook-token"] || null;
  if (token !== VERIFY_TOKEN) {
    return res.status(401).send("invalid token");
  }
}
```

### Incoming Webhook Format
```json
{
  "messages": [
    {
      "id": "PrDvEiROc.V_9YU-l_ABq52oRURpIQ-H9s",
      "from": "919071719533@s.whatsapp.net",
      "from_me": false,
      "type": "text",
      "timestamp": 1758192151,
      "source": "web",
      "text": {
        "body": "Hello"
      }
    }
  ]
}
```

### Webhook Processing
**Location**: `server.js:565-685`

```javascript
app.post("/webhook", async (req, res) => {
  // 1. Verify token (if configured)
  // 2. Extract and normalize message data
  // 3. Check for duplicate messages
  // 4. Detect phantom deliveries
  // 5. Process user interactions
  // 6. Queue appropriate responses

  return res.status(200).send("processed");
});
```

## Error Handling

### Common Error Codes

#### 401 Unauthorized
**Cause**: Invalid or expired API key
**Solution**: Verify `SEND_API_KEY` in environment
**Retry**: No (authentication issue)

#### 403 Forbidden
**Cause**: Account restrictions or policy violations
**Solution**: Contact WHAPI support
**Retry**: No (account issue)

#### 429 Too Many Requests
**Cause**: Rate limit exceeded
**Solution**: Reduce request frequency
**Retry**: Yes (after delay)

#### 500 Internal Server Error
**Cause**: WHAPI service issues
**Solution**: Retry with exponential backoff
**Retry**: Yes (temporary issue)

#### Timeout (ECONNABORTED)
**Cause**: Request exceeded timeout limit
**Solution**: Increase timeout or retry
**Retry**: Yes (with longer timeout)

### Error Analysis Implementation
**Location**: `server.js:74-93`

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
        data: typeof err.config.data === "string" ?
          err.config.data.slice(0, 2000) : err.config.data,
      };
      console.error(`${tag} - request:`, JSON.stringify(cfg));
    }

    if (err?.response) {
      console.error(`${tag} - response.status:`, err.response.status);
      console.error(`${tag} - response.headers:`,
        JSON.stringify(err.response.headers).slice(0, 2000));
      console.error(`${tag} - response.body:`,
        JSON.stringify(err.response.data).slice(0, 8000));
    }
  } catch (ex) {
    console.error("Failed to log axios error fully", ex);
  }
}
```

## Rate Limiting

### WHAPI Guidelines
- **Maximum**: 2 messages per minute
- **Recommended**: Conservative implementation
- **Consequences**: Account suspension for violations

### Implementation
**Location**: `server.js:167-178`

```javascript
const RATE_LIMIT_PER_MINUTE = 2;
const rateLimitWindow = new LRU({ max: 1000, ttl: 60000 }); // 1 minute TTL

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

### Rate Limit Integration
Applied to all outbound API calls:

```javascript
if (!checkRateLimit()) {
  throw new Error('Rate limit exceeded - please retry later');
}

// Proceed with API call
await axios.post(API_URL, payload, options);
```

## Performance Optimization

### Request Correlation
Every API request includes correlation headers:

```javascript
const headers = {
  Authorization: `Bearer ${SEND_API_KEY}`,
  "Content-Type": "application/json",
  "X-Request-Id": trace.id  // Unique correlation ID
};
```

### Response Analysis
Detailed performance monitoring:

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

### Phantom Delivery Detection
WHAPI sometimes delivers "failed" requests later:

```javascript
// Track outbound messages
const messageKey = `out:${toPhone}:${crypto.createHash('sha256').update(body).digest('hex').slice(0,12)}`;
outboundMessageCache.set(messageKey, {
  fingerprint,
  timestamp: Date.now(),
  traceId: trace.id
});

// Detect phantom deliveries on webhook
if (incoming.text) {
  const messageKey = `out:${from}:${crypto.createHash('sha256').update(incoming.text).digest('hex').slice(0,12)}`;
  const outboundRecord = outboundMessageCache.get(messageKey);
  if (outboundRecord) {
    console.log(`PHANTOM DELIVERY DETECTED: ${messageKey}`);
    return res.status(200).send("ignored-phantom-delivery");
  }
}
```

## Best Practices

### 1. Timeout Configuration
```javascript
// Conservative timeouts to handle WHAPI latency
const TEXT_TIMEOUT_MS = 8000;      // 8 seconds for text
const DOC_TIMEOUT_MS = 30000;      // 30 seconds for documents
const JOB_TEXT_TIMEOUT_MS = 30000; // 30 seconds for retries
```

### 2. Request Headers
```javascript
// Always include these headers
const headers = {
  Authorization: `Bearer ${SEND_API_KEY}`,
  "Content-Type": "application/json",
  "X-Request-Id": crypto.randomUUID(), // For correlation
  "User-Agent": "BBWAB/1.0"            // Optional: Identify your app
};
```

### 3. Error Handling Strategy
```javascript
// Categorize errors for appropriate handling
const retryableErrors = ['ECONNABORTED', 'ENOTFOUND', 'ECONNRESET'];
const authErrors = [401, 403];
const rateLimitErrors = [429];

if (authErrors.includes(response.status)) {
  // Don't retry, fix authentication
  throw new Error('Authentication failed');
} else if (rateLimitErrors.includes(response.status)) {
  // Retry after delay
  await sleep(60000); // Wait 1 minute
} else if (retryableErrors.includes(error.code)) {
  // Retry with exponential backoff
  await exponentialBackoff(attempt);
}
```

### 4. Media Management
```javascript
// Verify media ID format before using
function isValidMediaId(mediaId) {
  return /^pdf-[a-f0-9]+-[a-f0-9]+$/.test(mediaId);
}

// Use consistent filename formatting
function formatFilename(name) {
  return name.replace(/[^a-zA-Z0-9\s.-]/g, '').trim();
}
```

## Testing and Development

### Testing API Integration
```bash
# Test text endpoint
curl -X POST "https://gate.whapi.cloud/messages/text" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":"your_test_number","body":"Test message"}'

# Test document endpoint
curl -X POST "https://gate.whapi.cloud/messages/document" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":"your_test_number","media":"your_media_id","type":"document"}'
```

### Development Test Endpoint
**Location**: `server.js:175-210`

```bash
# Test via application
curl -X POST "https://your-app.railway.app/test-url" \
  -H "Content-Type: application/json" \
  -d '{"to":"your_test_number","url":"Test message"}'
```

### Webhook Testing
```bash
# Use ngrok for local testing
ngrok http 8080

# Configure WHAPI webhook to ngrok URL
# https://abc123.ngrok.io/webhook
```

## Migration and Updates

### API Version Management
- Monitor WHAPI changelog for API updates
- Test changes in development before production
- Maintain backward compatibility when possible

### Configuration Updates
```javascript
// Environment-driven API URLs for flexibility
const SEND_TEXT_URL = process.env.SEND_TEXT_URL || "https://gate.whapi.cloud/messages/text";
const SEND_DOC_URL = process.env.SEND_DOC_URL || "https://gate.whapi.cloud/messages/document";
```

### Health Monitoring
```javascript
// Regular health checks
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    whapi_configured: !!SEND_API_KEY,
    media_configured: !!COMBINED_MEDIA_ID,
    rate_limit: RATE_LIMIT_PER_MINUTE
  });
});
```

This integration guide provides comprehensive coverage of WHAPI.cloud API usage within the BBWAB system. For additional details, refer to the [Function Reference](./FUNCTION_REFERENCE.md) and [Troubleshooting Guide](./TROUBLESHOOTING.md).