# Troubleshooting Guide

## Common Issues and Solutions

### 1. Startup Issues

#### Error: "Missing SEND_API_KEY - aborting"
**Cause**: WHAPI API key not configured
**Solution**:
1. Check Railway environment variables
2. Ensure `SEND_API_KEY` is set with valid WHAPI token
3. Verify token format (should be alphanumeric string ~32 characters)

**Verification**:
```bash
# Check Railway dashboard → Variables tab
# Should show: SEND_API_KEY = QoFrXzOQxjr1hO7tO2V7TYUPF05T5794 (example)
```

#### Error: "Missing COMBINED_MEDIA_ID - aborting"
**Cause**: PDF media ID not configured
**Solution**:
1. Upload PDF using `preupload.js`
2. Copy media ID from upload response
3. Set `COMBINED_MEDIA_ID` in Railway environment

**Steps**:
```bash
# 1. Configure upload environment
UPLOAD_URL=https://gate.whapi.cloud/messages/document
UPLOAD_API_KEY=your_whapi_token
PDF_PATH=./your-pdf-file.pdf

# 2. Run upload script
node preupload.js

# 3. Copy media ID from output
# Example output: "MEDIA_ID (set this in Railway): pdf-3eca2ab696205ded438514-c027d5fcf1806d"

# 4. Set in Railway
COMBINED_MEDIA_ID=pdf-3eca2ab696205ded438514-c027d5fcf1806d
```

#### Error: "Port already in use"
**Cause**: Development server conflict
**Solution**:
```bash
# Kill existing process
pkill -f "node server.js"

# Or use different port
PORT=8081 node server.js
```

### 2. Webhook Issues

#### Error: "invalid token" (HTTP 401)
**Cause**: Webhook verification token mismatch
**Symptoms**:
- All webhooks return 401
- WHAPI shows failed webhook deliveries

**Solution**:
1. Check WHAPI webhook configuration
2. Ensure `VERIFY_TOKEN` matches in both systems
3. Or remove verification by unsetting `VERIFY_TOKEN`

**Debug Steps**:
```javascript
// Check headers in webhook request
console.log("Webhook headers:", req.headers);
console.log("Expected token:", VERIFY_TOKEN);
console.log("Received token:", req.headers["x-whapi-token"]);
```

#### Error: "missing-sender" (HTTP 400)
**Cause**: Invalid phone number in webhook
**Symptoms**:
- Newsletter/channel messages
- Malformed phone numbers

**Normal Behavior**: This is expected for non-user messages
**Solution**: No action needed - system correctly rejects invalid senders

**Log Example**:
```
invalid from: {"chat_id":"120363161097627937@newsletter",...}
```

#### Error: Webhook timeout
**Cause**: Slow processing or rate limiting
**Symptoms**:
- WHAPI shows webhook timeouts
- Messages not processed

**Solution**:
1. Check rate limit logs
2. Verify queue processing is running
3. Increase webhook timeout in WHAPI (if possible)

### 3. Message Delivery Issues

#### Issue: Messages not sending
**Symptoms**:
- Webhooks received but no outbound messages
- "Rate limit exceeded" logs

**Diagnosis**:
```bash
# Check recent logs for rate limiting
grep "Rate limit exceeded" logs

# Check queue status
grep "Queued.*for.*in.*ms" logs

# Check processing
grep "executeQueuedMessage" logs
```

**Solutions**:
1. **Rate Limited**: Wait for next minute window
2. **Queue Stuck**: Restart application
3. **API Issues**: Check WHAPI service status

#### Issue: Duplicate messages
**Symptoms**:
- Users receive multiple identical messages
- "PHANTOM DELIVERY DETECTED" not appearing in logs

**Diagnosis**:
```bash
# Check for phantom deliveries
grep "PHANTOM DELIVERY DETECTED" logs

# Check outbound tracking
grep "outboundMessageCache" logs

# Check fingerprint collisions
grep "SKIPPED.*fingerprint" logs
```

**Solutions**:
1. **No phantom detection**: Check `outboundMessageCache` implementation
2. **Cache too small**: Increase cache size or TTL
3. **Fingerprint collision**: Review fingerprint generation

#### Issue: PDF not delivering
**Symptoms**:
- Text messages work, PDFs fail
- "sendDocumentRobust" errors

**Common Causes**:
1. **Invalid Media ID**: PDF not properly uploaded
2. **File Too Large**: PDF exceeds WHAPI limits
3. **API Timeout**: Document timeout too low

**Diagnosis**:
```bash
# Check document send attempts
grep "docAttempt" logs

# Check media ID format
echo $COMBINED_MEDIA_ID
# Should be: pdf-[hash]-[hash] format

# Check file size (WHAPI limit: 100MB)
```

**Solutions**:
```javascript
// 1. Re-upload PDF
node preupload.js

// 2. Increase timeout
DOC_TIMEOUT_MS=60000

// 3. Verify media ID format
// Valid: pdf-3eca2ab696205ded438514-c027d5fcf1806d
// Invalid: document_123, file.pdf, etc.
```

### 4. Performance Issues

#### Issue: Slow response times
**Symptoms**:
- Long delays before message delivery
- Queue processing slow

**Diagnosis**:
```bash
# Check timing logs
grep "timing.*ms" logs

# Check queue depth
grep "Queued.*messages" logs

# Check rate limiting frequency
grep "Rate limit hit" logs
```

**Solutions**:
1. **High queue depth**: Rate limiting working correctly (expected)
2. **API timeouts**: Increase timeout values
3. **Memory issues**: Monitor Railway metrics

#### Issue: Memory usage growing
**Symptoms**:
- Application restarts
- Railway memory alerts

**Diagnosis**:
```bash
# Check cache sizes
grep "max.*entries" logs

# Monitor Railway metrics dashboard
```

**Solutions**:
```javascript
// Reduce cache sizes
const MAX_DEDUPE_ENTRIES = 5000; // Reduce from 10000
const userInteractionCache = new LRU({ max: 5000, ttl: 7 * 24 * 60 * 60 * 1000 });

// Or increase Railway memory allocation
```

### 5. API Integration Issues

#### Issue: WHAPI authentication errors
**Symptoms**:
- 401/403 responses
- "Authorization failed" logs

**Solutions**:
1. **Verify API key**: Check WHAPI dashboard for correct token
2. **Key expiration**: Generate new API key
3. **Account suspension**: Contact WHAPI support

**Testing**:
```bash
# Test API key manually
curl -H "Authorization: Bearer YOUR_TOKEN" \
     "https://gate.whapi.cloud/health"

# Should return 200 OK
```

#### Issue: WHAPI rate limiting
**Symptoms**:
- 429 responses
- "Too Many Requests" errors

**Note**: Different from app rate limiting
**Solutions**:
1. **Reduce app rate limit**: Set `RATE_LIMIT_PER_MINUTE=1`
2. **Check WHAPI account limits**: Review WHAPI dashboard
3. **Contact WHAPI**: May need plan upgrade

#### Issue: Webhook URL not accessible
**Symptoms**:
- WHAPI shows "Connection failed"
- No webhooks received

**Diagnosis**:
```bash
# Test webhook URL externally
curl https://your-app.railway.app/health

# Should return: {"ok":true}
```

**Solutions**:
1. **Railway deployment failed**: Check deployment logs
2. **Wrong URL**: Verify Railway domain
3. **Network issues**: Check Railway status

### 6. Environment Configuration Issues

#### Issue: Environment variables not loading
**Symptoms**:
- Default values used instead of configured values
- "undefined" in logs

**Diagnosis**:
```javascript
// Add debug logging in server.js
console.log("Environment loaded:", {
  SEND_API_KEY: SEND_API_KEY ? "SET" : "MISSING",
  COMBINED_MEDIA_ID: COMBINED_MEDIA_ID ? "SET" : "MISSING",
  TEXT_TIMEOUT_MS: TEXT_TIMEOUT_MS
});
```

**Solutions**:
1. **Railway sync**: Restart deployment after environment changes
2. **Variable names**: Check for typos in variable names
3. **Spaces**: Ensure no trailing spaces in values

#### Issue: Timezone-related problems
**Symptoms**:
- Logs show wrong timestamps
- Queue timing issues

**Solution**:
```javascript
// Set timezone in Railway environment
TZ=Asia/Kolkata

// Or UTC for consistency
TZ=UTC
```

### 7. Development and Testing Issues

#### Issue: Local development setup
**Problem**: Testing webhook locally
**Solution**: Use ngrok for local webhook testing

```bash
# Install ngrok
npm install -g ngrok

# Run local server
node server.js

# Expose to internet (new terminal)
ngrok http 8080

# Use ngrok URL in WHAPI webhook settings
# Example: https://abc123.ngrok.io/webhook
```

#### Issue: Testing without affecting users
**Solution**: Use test endpoint with specific number

```bash
# Test message sending
curl -X POST https://your-app.railway.app/test-url \
  -H "Content-Type: application/json" \
  -d '{
    "to": "your_test_number",
    "url": "Test message"
  }'
```

#### Issue: Debugging async operations
**Problem**: Hard to trace async message flows
**Solution**: Use trace IDs in logs

```bash
# Follow specific trace
grep "TRACE abc123-def456" logs

# Find all traces for user
grep "to.*919071719533" logs | grep "TRACE"
```

## Diagnostic Commands

### Health Check
```bash
# Basic connectivity
curl https://your-app.railway.app/health

# Should return: {"ok":true}
```

### Rate Limit Status
```bash
# Check current rate limit usage
grep "Rate limit" logs | tail -10
```

### Queue Status
```bash
# Check queue processing
grep "Queued\|Processing\|executed" logs | tail -20
```

### User Interaction History
```bash
# Check specific user interactions
grep "919071719533" logs | grep -E "(contacted|queued|sent)"
```

### API Performance
```bash
# Check API response times
grep "timing.*ms" logs | tail -10

# Check timeout patterns
grep "timeout.*exceeded" logs | tail -10
```

### Memory Usage
```bash
# Check cache operations
grep -E "(cache|LRU)" logs | tail -10
```

## Recovery Procedures

### 1. Service Recovery
**If application is completely down**:
1. Check Railway deployment status
2. Review recent deployment logs
3. Restart service if needed
4. Verify environment variables

### 2. Queue Recovery
**If messages are stuck in queue**:
1. Restart application (clears in-memory queue)
2. Monitor new message processing
3. Check rate limiting is working

### 3. Data Recovery
**If user data is lost** (after restart):
- No action needed - system designed for stateless operation
- Users will be reprocessed as new (intended behavior)
- One-contact policy prevents spam

### 4. API Recovery
**If WHAPI is down**:
1. Monitor WHAPI status page
2. Queue will automatically retry when service returns
3. No manual intervention needed

## Monitoring Recommendations

### Key Metrics to Track
1. **Messages sent per minute** - Should not exceed rate limit
2. **API timeout frequency** - Should be <10%
3. **Queue depth** - Normal: 0-5, concerning: >20
4. **Phantom delivery detection** - Should catch duplicates
5. **User contact rate** - New users per hour

### Alert Thresholds
```javascript
// Set up monitoring for:
Rate limit exceeded > 5 times/hour
API timeouts > 20% of requests
Queue depth > 50 messages
Memory usage > 400MB
Phantom deliveries > 5% of total sends
```

### Log Analysis Tools
```bash
# Daily summary
grep -c "SUCCESS" logs
grep -c "failed" logs
grep -c "PHANTOM DELIVERY" logs

# Performance summary
grep "timing.*ms" logs | awk '{print $NF}' | sort -n | tail -10

# Error summary
grep "Error:" logs | sort | uniq -c | sort -nr
```

This troubleshooting guide covers the most common issues and their solutions. For issues not covered here, check the [Evolution Log](./EVOLUTION_LOG.md) for historical context or contact the development team.