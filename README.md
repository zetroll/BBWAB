# BBWAB - MSME AI Readiness Assessment Bot

## Project Overview

BBWAB (Business Bot for WhatsApp Broadcasting) is a WhatsApp bot designed to conduct AI readiness assessments for MSMEs (Micro, Small, and Medium Enterprises). The bot delivers a 12-question survey via interactive buttons, scores responses, and provides personalized action plans based on three readiness tiers.

## Key Features

- **Keyword-Triggered Survey**: Users start the assessment by sending "mining"
- **Interactive Questions**: 12 questions across 3 sections using WhatsApp quick reply buttons
- **Automatic Scoring**: Real-time score calculation (0-35 points)
- **Three-Tier Results**:
  - **Tier 1 (25-35 points)**: AI Ready - immediate implementation guidance
  - **Tier 2 (15-24 points)**: AI Curious - educational resources and proof-building
  - **Tier 3 (0-14 points)**: AI Explorers - foundational digital infrastructure guidance
- **Anti-Ban Compliance**: Follows WHAPI.cloud guidelines with rate limiting and natural delays
- **Comprehensive Logging**: Full request tracing and analytics

## Quick Start

1. **Environment Setup**: Configure Railway environment variables (see [Environment Guide](./docs/ENVIRONMENT.md))
2. **Deploy**: Push to Railway
3. **Configure Webhook**: Point WHAPI webhook to your Railway domain
4. **Test**: Send "mining" to the bot number to start a survey

## Documentation Structure

This project documentation is organized into multiple focused documents:

### Core Documentation
- **[README.md](./README.md)** - This overview document
- **[PROJECT_ARCHITECTURE.md](./docs/PROJECT_ARCHITECTURE.md)** - System design and architecture
- **[ENVIRONMENT.md](./docs/ENVIRONMENT.md)** - Environment variables and configuration

### Implementation Guides
- **[ANTI_BAN_IMPLEMENTATION.md](./docs/ANTI_BAN_IMPLEMENTATION.md)** - Anti-ban strategy and implementation
- **[API_INTEGRATION.md](./docs/API_INTEGRATION.md)** - WHAPI integration details
- **[DEPLOYMENT_GUIDE.md](./docs/DEPLOYMENT_GUIDE.md)** - Railway deployment instructions

### Historical Documentation
- **[TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)** - Common issues and solutions
- **[EVOLUTION_LOG.md](./docs/EVOLUTION_LOG.md)** - Project evolution and learnings

## Survey Structure

### Section 1: Current State (4 questions)
- Business operations digitization level
- Current tools and software usage
- Time spent on repetitive tasks
- Biggest operational challenges

### Section 2: Readiness (4 questions)
- AI awareness and exposure
- Concerns about AI adoption
- Priority problems to solve
- Available budget

### Section 3: Decision-Making (4 questions)
- Decision-making style
- Tool adoption approach
- Implementation resources
- Business network participation

## System Requirements

- **Node.js**: 16+
- **Memory**: 512MB minimum
- **Dependencies**: See package.json
- **External Services**: WHAPI.cloud account

## Environment Variables

### Required
- `SEND_API_KEY` - WHAPI API authentication token
- `PORT` - Server port (default: 8080)

### Optional
- `VERIFY_TOKEN` - Webhook verification token
- `SENDER_PHONE` - Bot phone number (for self-message filtering)
- `ADMIN_KEY` - Admin endpoints authentication
- `TEXT_TIMEOUT_MS` - Message sending timeout (default: 8000ms)
- `RATE_LIMIT_PER_MINUTE` - Max messages per minute (default: 2)

## API Endpoints

### Health Check
- `GET /health` - Service health status

### Webhook
- `POST /webhook` - Main WhatsApp message handler

### Admin
- `GET /admin/survey-stats` - Survey completion statistics (requires ADMIN_KEY)

## Usage Flow

1. **First Contact**: User receives welcome message with instructions
2. **Start Survey**: User sends "mining" to begin assessment
3. **Answer Questions**: User selects answers via WhatsApp quick reply buttons
4. **Receive Results**: After Q12, bot calculates score and sends appropriate action plan
5. **Action Plan Delivery**: Multi-message plan sent with anti-ban delays

## Anti-Ban Measures

- **Rate Limiting**: Maximum 2 messages per minute (WHAPI guideline)
- **Random Delays**: 2-10 second delays between messages
- **Message Queue**: Delayed processing to appear natural
- **User Tracking**: One-time survey per user (24-hour state retention)
- **Phantom Delivery Protection**: Duplicate send prevention

## Scoring System

- **Maximum Score**: 35 points
- **Q2 Special**: Multi-select capped at 4 points
- **Q7 Special**: Open text (0 points, informational only)
- **Tier Thresholds**:
  - AI Ready: 25-35 points
  - AI Curious: 15-24 points
  - AI Explorers: 0-14 points

## Development

### Local Testing
```bash
npm install
node server.js
```

### Admin Statistics
```bash
curl -H "x-admin-key: YOUR_ADMIN_KEY" https://your-domain.railway.app/admin/survey-stats
```

## Archive

The original PDF distribution bot has been archived in `archive/pdf-sender/` for reference. See `archive/README.md` for restoration instructions.

## Security Considerations

⚠️ **CRITICAL**: Never commit API keys or tokens to version control
⚠️ **IMPORTANT**: Monitor rate limits to prevent service disruption
⚠️ **WARNING**: Survey state is in-memory - data lost on restart

## Support

For technical issues, refer to:
1. [Troubleshooting Guide](./docs/TROUBLESHOOTING.md)
2. [WHAPI Documentation](https://whapi.cloud/docs)
3. [Project Evolution Log](./docs/EVOLUTION_LOG.md) for context

## License

Internal project - All rights reserved
