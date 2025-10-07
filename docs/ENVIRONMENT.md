# Environment Configuration

## Required Environment Variables

### Core API Configuration

#### `SEND_API_KEY` (REQUIRED)
**Type**: String
**Description**: WHAPI.cloud authentication token
**Example**: `QoFrXzOQxjr1hO7tO2V7TYUPF05T5794`
**Security**: 🔴 **CRITICAL** - Never commit to version control

#### `COMBINED_MEDIA_ID` (REQUIRED)
**Type**: String
**Description**: Media ID of the combined PDF uploaded to WHAPI
**Example**: `pdf-3eca2ab696205ded438514-c027d5fcf1806d`
**Notes**: Get this ID after uploading PDF using `preupload.js` or WHAPI dashboard

#### `COMBINED_FILENAME` (OPTIONAL)
**Type**: String
**Default**: `"Dilip's Favourite Products.pdf"`
**Description**: Filename displayed when PDF is sent
**Example**: `"Product Catalog 2025.pdf"`

### API Endpoints (OPTIONAL)

#### `SEND_TEXT_URL` (OPTIONAL)
**Type**: String
**Default**: `"https://gate.whapi.cloud/messages/text"`
**Description**: WHAPI text message endpoint
**Note**: Only change if using custom WHAPI instance

#### `SEND_DOC_URL` (OPTIONAL)
**Type**: String
**Default**: `"https://gate.whapi.cloud/messages/document"`
**Description**: WHAPI document message endpoint
**Note**: Only change if using custom WHAPI instance

### Messaging Configuration

#### `INTRO_TEXT` (OPTIONAL)
**Type**: String
**Default**: `"Hi, I'm Dileep, and I want to share my favourite products with you!"`
**Description**: Introduction message sent to users
**Example**: `"Welcome! Here are our best deals for you."`
**Supports**: Unicode, emojis, line breaks

### Security Configuration

#### `VERIFY_TOKEN` (OPTIONAL)
**Type**: String
**Default**: `null`
**Description**: Webhook verification token for added security
**Example**: `"my_secret_webhook_token"`
**Headers**: Checks `x-whapi-token` or `x-webhook-token` headers

#### `SENDER_PHONE` (OPTIONAL)
**Type**: String
**Default**: `null`
**Description**: Your bot's phone number to ignore self-messages
**Example**: `"917490034049"`
**Format**: Include country code without '+' or spaces

### Performance Tuning

#### `TEXT_TIMEOUT_MS` (OPTIONAL)
**Type**: Integer
**Default**: `8000`
**Description**: Timeout for text message API calls (milliseconds)
**Range**: 1000-60000
**Recommendation**: 8000ms for balance of speed and reliability

#### `DOC_TIMEOUT_MS` (OPTIONAL)
**Type**: Integer
**Default**: `30000`
**Description**: Timeout for document API calls (milliseconds)
**Range**: 5000-60000
**Note**: Documents typically take longer than text

#### `JOB_TEXT_TIMEOUT_MS` (OPTIONAL)
**Type**: Integer
**Default**: `30000`
**Description**: Timeout for retry job text messages
**Range**: 10000-60000
**Note**: Longer timeout for background retries

### Retry Configuration

#### `TEXT_IMMEDIATE_TRIES` (OPTIONAL)
**Type**: Integer
**Default**: `1`
**Description**: Number of immediate retry attempts for text messages
**Range**: 1-3
**⚠️ WARNING**: Higher values may trigger rate limits

#### `JOB_MAX_RETRIES` (OPTIONAL)
**Type**: Integer
**Default**: `2`
**Description**: Maximum retry attempts in job queue
**Range**: 1-5
**Note**: Reduced from 5 to prevent excessive retries

#### `DOC_RETRIES` (OPTIONAL)
**Type**: Integer
**Default**: `1`
**Description**: Number of retry attempts for document sending
**Range**: 1-3
**Note**: Includes JSON → multipart fallback

#### `JOB_RETRY_BASE_MS` (OPTIONAL)
**Type**: Integer
**Default**: `2000`
**Description**: Base delay between job retries (milliseconds)
**Range**: 1000-10000
**Note**: Uses exponential backoff (base × 2^attempt)

### Anti-Ban Configuration

#### `RATE_LIMIT_PER_MINUTE` (OPTIONAL)
**Type**: Integer
**Default**: `2`
**Description**: Maximum messages sent per minute
**Range**: 1-5
**⚠️ CRITICAL**: Exceeding 2/minute may trigger WhatsApp bans
**WHAPI Guideline**: 2 messages per minute maximum

#### `PHANTOM_DELIVERY_WINDOW_MS` (OPTIONAL)
**Type**: Integer
**Default**: `120000` (2 minutes)
**Description**: Window to track phantom deliveries
**Range**: 60000-300000
**Purpose**: Prevents duplicate sends from delayed WHAPI responses

#### `SENT_CACHE_TTL_MS` (OPTIONAL)
**Type**: Integer
**Default**: `30000` (30 seconds)
**Description**: Cache TTL for sent message deduplication
**Range**: 10000-120000
**Note**: Reduced from 10 minutes to allow session retries

### Cache Configuration

#### `DEDUPE_TTL_MIN` (OPTIONAL)
**Type**: Integer
**Default**: `5`
**Description**: Message ID deduplication TTL (minutes)
**Range**: 1-60
**Purpose**: Prevents processing duplicate webhooks

#### `MAX_DEDUPE_ENTRIES` (OPTIONAL)
**Type**: Integer
**Default**: `10000`
**Description**: Maximum entries in deduplication cache
**Range**: 1000-50000
**Memory Impact**: ~50KB per 1000 entries

### Development Configuration

#### `PORT` (OPTIONAL)
**Type**: Integer
**Default**: `8080`
**Description**: Server port for Railway deployment
**Note**: Railway sets this automatically

#### `ADMIN_KEY` (OPTIONAL)
**Type**: String
**Default**: `null`
**Description**: Admin endpoints authentication (DEPRECATED)
**Status**: No longer used in current version

## Railway Environment Setup

### Step-by-Step Configuration

1. **Access Railway Dashboard**
   - Navigate to your project
   - Go to "Variables" tab

2. **Required Variables**
   ```bash
   SEND_API_KEY=your_whapi_token_here
   COMBINED_MEDIA_ID=your_pdf_media_id_here
   ```

3. **Recommended Variables**
   ```bash
   INTRO_TEXT=Hi, I'm Dileep, and I want to share my favourite products with you!
   COMBINED_FILENAME=Dilip's Favourite Products.pdf
   VERIFY_TOKEN=your_webhook_secret_here
   ```

4. **Performance Tuning** (Optional)
   ```bash
   TEXT_TIMEOUT_MS=8000
   DOC_TIMEOUT_MS=30000
   JOB_MAX_RETRIES=2
   RATE_LIMIT_PER_MINUTE=2
   ```

### Environment Validation

The application validates critical environment variables on startup:

```javascript
if (!SEND_API_KEY) {
  console.error("Missing SEND_API_KEY - aborting.");
  process.exit(1);
}

if (!COMBINED_MEDIA_ID) {
  console.error("Missing COMBINED_MEDIA_ID - aborting.");
  process.exit(1);
}
```

**Startup Failure**: Application will not start without required variables

## Security Best Practices

### Secret Management
✅ **DO**:
- Store all secrets in Railway environment variables
- Use VERIFY_TOKEN for webhook security
- Rotate API keys regularly
- Monitor access logs

❌ **DON'T**:
- Commit secrets to Git
- Share API keys in chat/email
- Use production keys in development
- Log sensitive values

### API Key Security
- **WHAPI Token**: Has full access to your WhatsApp instance
- **Verification Token**: Prevents unauthorized webhook access
- **Admin Key**: DEPRECATED - no longer used

### Access Control
```javascript
// Webhook verification (if VERIFY_TOKEN set)
if (VERIFY_TOKEN) {
  const token = req.headers["x-whapi-token"] || req.headers["x-webhook-token"] || null;
  if (token !== VERIFY_TOKEN) return res.status(401).send("invalid token");
}
```

## Troubleshooting Configuration

### Common Issues

#### "Missing SEND_API_KEY"
- **Cause**: API key not set in Railway
- **Solution**: Add SEND_API_KEY to Railway environment variables
- **Check**: Railway dashboard → Variables tab

#### "Missing COMBINED_MEDIA_ID"
- **Cause**: PDF not uploaded or media ID not set
- **Solution**: Upload PDF using `preupload.js` and set media ID
- **Check**: Run `node preupload.js` to get media ID

#### "Rate limit exceeded"
- **Cause**: RATE_LIMIT_PER_MINUTE set too high
- **Solution**: Reduce to 2 or lower
- **Check**: Monitor logs for rate limit warnings

#### "Webhook verification failed"
- **Cause**: VERIFY_TOKEN mismatch with WHAPI configuration
- **Solution**: Match token in both Railway and WHAPI dashboard
- **Check**: WHAPI webhook settings

### Configuration Testing

#### Test Environment Variables
```bash
# Check if variables are loaded correctly
curl https://your-app.railway.app/health
```

#### Test Media ID
```bash
# Use test endpoint (development only)
curl -X POST https://your-app.railway.app/test-url \
  -H "Content-Type: application/json" \
  -d '{"to":"your_test_number","url":"test message"}'
```

### Performance Monitoring

#### Key Metrics to Monitor
- Messages per minute (should not exceed RATE_LIMIT_PER_MINUTE)
- API response times (TEXT_TIMEOUT_MS / DOC_TIMEOUT_MS)
- Retry rates (JOB_MAX_RETRIES effectiveness)
- Cache hit rates (SENT_CACHE_TTL_MS optimization)

#### Log Analysis
```javascript
// Look for these log patterns
"Rate limit exceeded" // Increase delays or reduce rate limit
"timeout of 8000ms exceeded" // Consider increasing TEXT_TIMEOUT_MS
"Job exhausted attempts" // Check API connectivity
"PHANTOM DELIVERY DETECTED" // Normal - anti-duplicate working
```

## Migration from Old Configuration

### Removed Variables (Clean Up)
If migrating from an older version, remove these deprecated variables:

```bash
# Interactive system (removed)
INTERACTIVE_BODY
TV_BUTTON_TITLE, TV_BUTTON_ID, TV_MEDIA_ID
AC_BUTTON_TITLE, AC_BUTTON_ID, AC_MEDIA_ID
REFRIGERATOR_BUTTON_TITLE, REFRIGERATOR_BUTTON_ID, REFRIGERATOR_MEDIA_ID
WASHING_MACHINE_BUTTON_TITLE, WASHING_MACHINE_BUTTON_ID, WASHING_MACHINE_MEDIA_ID

# Link sending (removed)
TV_LINK, AC_LINK

# High-rate limiting (removed)
RATE_LIMIT_TPS

# Admin system (removed)
ADMIN_KEY

# URL testing (removed)
UPLOAD_URL, UPLOAD_API_KEY, PDF_PATH
```

### Variable Mapping
```bash
# Old → New
RATE_LIMIT_TPS → RATE_LIMIT_PER_MINUTE (value: 2)
TV_MEDIA_ID → COMBINED_MEDIA_ID (use combined PDF)
(multiple category PDFs) → COMBINED_MEDIA_ID (single PDF)
```

This configuration system provides comprehensive control over bot behavior while maintaining security and compliance with WHAPI's anti-ban guidelines.