# Project Architecture

## System Overview

BBWAB follows a webhook-driven architecture with sophisticated queue management and anti-ban measures. The system is designed to handle incoming WhatsApp messages, process them through anti-spam filters, and respond with appropriate PDF distributions while maintaining compliance with WhatsApp's terms of service.

## Architecture Diagram

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   WhatsApp      │───▶│   WHAPI.cloud    │───▶│   BBWAB Bot     │
│   Users         │    │   Gateway        │    │   (Railway)     │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                                        │
                                                        ▼
                                               ┌─────────────────┐
                                               │  Message Queue  │
                                               │  & Anti-Ban     │
                                               │  Processing     │
                                               └─────────────────┘
                                                        │
                                                        ▼
                                               ┌─────────────────┐
                                               │   PDF & Text    │
                                               │   Delivery      │
                                               └─────────────────┘
```

## Core Components

### 1. Webhook Handler (`/webhook` endpoint)
**Location**: `server.js:565-685`

The main entry point for all WhatsApp messages. Handles:
- Webhook verification and authentication
- Message parsing and validation
- User state management
- Queue decision logic

**Critical Functions**:
- `extractCommon()` - Parses incoming webhook data
- `normalizePhone()` - Standardizes phone number format
- Phantom delivery detection
- Duplicate message prevention

### 2. Anti-Ban System
**Location**: `server.js:56-95` (configuration), `server.js:200-350` (implementation)

Implements WHAPI.cloud's anti-ban guidelines:
- Rate limiting (2 messages/minute max)
- User interaction tracking (7-day TTL)
- Natural conversation patterns
- Randomized delays and greetings

**Key Components**:
- `userInteractionCache` - LRU cache for user states
- `messageQueue` - Delayed message processing
- `greetingBank` - Natural greeting variations
- `emojiResponses` - Follow-up response options

### 3. Message Queue System
**Location**: `server.js:200-280`

Manages delayed message delivery with anti-ban timing:
- Random delays (2-10 seconds)
- Rate-limited processing
- Graceful failure handling
- Queue persistence during runtime

**Core Functions**:
- `queueMessage()` - Adds messages to delayed queue
- `processMessageQueue()` - Processes ready messages
- `executeQueuedMessage()` - Executes specific message types

### 4. WHAPI Integration Layer
**Location**: `server.js:350-450`

Handles all WHAPI API communication:
- Text message sending
- Document/PDF delivery
- Request tracing and analytics
- Error handling and retries

**API Functions**:
- `sendTextOnce()` - Single text message with tracing
- `sendDocumentJsonOnce()` - JSON-based document sending
- `sendDocumentMultipartOnce()` - Multipart fallback
- `sendDocumentRobust()` - Retry logic for documents

### 5. Job Queue System (Legacy Retry)
**Location**: `server.js:135-190`

Background job processing for failed messages:
- Exponential backoff retries
- Job state management
- Concurrent processing prevention
- Maximum retry limits

## Data Flow

### New User Flow
1. **Webhook Reception**: Message arrives at `/webhook`
2. **User Lookup**: Check if user previously contacted
3. **Queue Decision**: Add to message queue with random delay
4. **Processing**: Queue processor picks up message when ready
5. **Delivery**: Send greeting + PDF with natural timing
6. **State Update**: Mark user as contacted

### Returning User Flow
1. **Webhook Reception**: Message arrives at `/webhook`
2. **User Lookup**: User found in interaction cache
3. **Response Logic**: Send single emoji response
4. **State Update**: Mark as responded, never respond again

### Error Handling Flow
1. **Primary Attempt**: Direct API call
2. **Failure Detection**: Timeout or error response
3. **Job Queue**: Add to retry queue with backoff
4. **Retry Processing**: Background job system handles retries
5. **Final Failure**: Log and abandon after max attempts

## Critical Security Measures

### Anti-Ban Implementation
- **Rate Limiting**: 2 messages per minute (WHAPI guideline)
- **Natural Patterns**: Random greetings, delays, emoji responses
- **One-Time Contact**: Never spam same user
- **Human Mimicry**: Varied timing and responses

### Request Security
- **API Authentication**: Bearer token validation
- **Webhook Verification**: Optional token verification
- **Request Tracing**: Unique IDs for all requests
- **Phantom Delivery Protection**: Duplicate send prevention

### Data Protection
- **No Persistence**: All data in-memory with TTL
- **Phone Normalization**: Consistent formatting
- **Cache Limits**: Maximum entry limits
- **Automatic Cleanup**: TTL-based data expiration

## Performance Characteristics

### Throughput Limits
- **Maximum Rate**: 2 messages/minute (120/hour)
- **Queue Capacity**: Unlimited (memory permitting)
- **Processing Latency**: 2-10 second delays (anti-ban)
- **User Capacity**: 10,000 tracked users (7-day TTL)

### Memory Usage
- **User Cache**: ~10KB per user × 10,000 = 100MB
- **Message Queue**: Variable based on pending messages
- **Job Queue**: Minimal (failed messages only)
- **Total Estimate**: 200-300MB runtime usage

### Scalability Considerations
- **Horizontal Scaling**: Not supported (in-memory state)
- **Vertical Scaling**: CPU/memory increases queue capacity
- **Redis Migration**: Required for distributed deployment
- **Load Balancing**: Would require shared state store

## External Dependencies

### WHAPI.cloud
- **Text API**: `https://gate.whapi.cloud/messages/text`
- **Document API**: `https://gate.whapi.cloud/messages/document`
- **Rate Limits**: 2 messages/minute recommended
- **Authentication**: Bearer token

### Railway Platform
- **Deployment**: Git-based continuous deployment
- **Environment**: Managed environment variables
- **Logging**: Centralized log aggregation
- **Monitoring**: Basic health checks

## Monitoring and Observability

### Request Tracing
Every API call includes:
- Unique trace ID
- Timing information
- Response analysis
- Error categorization

### Key Metrics
- Messages processed per minute
- Queue depth and processing time
- API success/failure rates
- User interaction patterns

### Health Endpoints
- `GET /health` - Basic service health
- `POST /test-url` - URL testing endpoint (development)
- `POST /admin/*` - Admin operations (if enabled)

## Dangerous Areas

⚠️ **CRITICAL - DO NOT MODIFY**:
- Anti-ban timing logic
- Rate limiting implementation
- User interaction tracking
- WHAPI API endpoints

⚠️ **HIGH RISK**:
- Message queue processing
- Job retry logic
- Phone number normalization
- Duplicate detection

⚠️ **MEDIUM RISK**:
- Greeting bank modifications
- Environment variable changes
- Logging configuration
- Health check endpoints