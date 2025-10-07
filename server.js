/**
 * server.js - MSME AI Readiness Assessment Survey Bot
 *
 * This bot conducts a 12-question assessment survey via WhatsApp to determine
 * MSME readiness for AI adoption. Based on responses, users are scored and
 * provided with tier-appropriate action plans.
 *
 * Features:
 *  - Keyword-triggered survey ("mining")
 *  - Interactive button-based questions
 *  - Automatic scoring (0-35 points)
 *  - Three-tier action plans (AI Ready, AI Curious, AI Explorers)
 *  - Anti-ban compliant (rate limiting, natural delays)
 *
 * NOTE: in-memory state tracking - suitable for single-instance deployment
 */

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
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
const SEND_INTERACTIVE_URL = process.env.SEND_INTERACTIVE_URL || "https://gate.whapi.cloud/messages/interactive";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || null;
const SENDER_PHONE = process.env.SENDER_PHONE || null;

const TEXT_TIMEOUT_MS = parseInt(process.env.TEXT_TIMEOUT_MS || "8000", 10); // 8s for message sending
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

// Survey state tracking
const surveyStateCache = new LRU({ max: 10000, ttl: 24 * 60 * 60 * 1000 }); // 24 hours

// Queue for delayed message sending (anti-ban timing)
const messageQueue = [];
const processingQueue = new Set();

/* -------- SURVEY QUESTIONS & SCORING -------- */
const SURVEY_QUESTIONS = [
  {
    id: 'q1',
    section: 'CURRENT STATE',
    text: 'Q1. Which best describes your current business operations?',
    options: [
      { id: 'a', text: 'Mostly paper-based or manual processes', points: 0 },
      { id: 'b', text: 'Some Excel/digital tools, but mostly manual', points: 1 },
      { id: 'c', text: 'Significant digital tools (accounting software, inventory systems, etc.)', points: 2 },
      { id: 'd', text: 'Fully digital operations with integrated systems', points: 3 }
    ]
  },
  {
    id: 'q2',
    section: 'CURRENT STATE',
    text: 'Q2. Do you currently use any of these? (Select all that apply)',
    options: [
      { id: 'a', text: 'WhatsApp for Business', points: 1 },
      { id: 'b', text: 'Excel for data tracking', points: 1 },
      { id: 'c', text: 'Accounting software (Tally, Zoho, etc.)', points: 1 },
      { id: 'd', text: 'CRM or inventory management software', points: 1 },
      { id: 'e', text: 'None of the above', points: 0 }
    ],
    multiSelect: true,
    maxPoints: 4
  },
  {
    id: 'q3',
    section: 'CURRENT STATE',
    text: 'Q3. How much time do you or your team spend on repetitive tasks weekly?',
    options: [
      { id: 'a', text: 'Very little, most work is unique', points: 0 },
      { id: 'b', text: '5-10 hours on repetitive tasks', points: 1 },
      { id: 'c', text: '10-20 hours on repetitive tasks', points: 2 },
      { id: 'd', text: '20+ hours on repetitive tasks', points: 3 }
    ]
  },
  {
    id: 'q4',
    section: 'CURRENT STATE',
    text: 'Q4. Your biggest operational headache right now is:',
    options: [
      { id: 'a', text: 'Cash flow/payment collection', points: 2 },
      { id: 'b', text: 'Compliance and paperwork', points: 2 },
      { id: 'c', text: 'Equipment breakdowns', points: 2 },
      { id: 'd', text: 'Quality control inconsistencies', points: 2 },
      { id: 'e', text: 'Finding new customers/markets', points: 2 },
      { id: 'f', text: 'Managing inventory', points: 2 },
      { id: 'g', text: 'None of the above/everything runs smoothly', points: 0 }
    ]
  },
  {
    id: 'q5',
    section: 'READINESS',
    text: 'Q5. Have you heard about AI being used in businesses like yours?',
    options: [
      { id: 'a', text: 'No, not really', points: 0 },
      { id: 'b', text: 'Yes, but only in large companies', points: 1 },
      { id: 'c', text: 'Yes, I know small businesses using it', points: 2 },
      { id: 'd', text: "Yes, and I've tried exploring it", points: 3 }
    ]
  },
  {
    id: 'q6',
    section: 'READINESS',
    text: "Q6. What's your biggest concern about using AI?",
    options: [
      { id: 'a', text: 'Too expensive', points: 1 },
      { id: 'b', text: 'Too complex/technical', points: 1 },
      { id: 'c', text: "My team won't adopt it", points: 1 },
      { id: 'd', text: "Don't trust it to work reliably", points: 1 },
      { id: 'e', text: "Don't know where to start", points: 2 },
      { id: 'f', text: "None, I'm ready to try", points: 3 }
    ]
  },
  {
    id: 'q7',
    section: 'READINESS',
    text: 'Q7. If AI could solve one problem for you, what would save you the most money/time?',
    options: [
      { id: 'open', text: 'Type your answer', points: 0 }
    ],
    openText: true
  },
  {
    id: 'q8',
    section: 'READINESS',
    text: 'Q8. Your budget for trying new business tools in the next quarter is:',
    options: [
      { id: 'a', text: 'Nothing right now', points: 0 },
      { id: 'b', text: 'Under ₹25,000', points: 1 },
      { id: 'c', text: '₹25,000 - ₹1,00,000', points: 2 },
      { id: 'd', text: '₹1,00,000+', points: 3 }
    ]
  },
  {
    id: 'q9',
    section: 'DECISION-MAKING',
    text: 'Q9. You make business decisions by:',
    options: [
      { id: 'a', text: 'Gut feel and experience', points: 1 },
      { id: 'b', text: 'Discussing with family/partners', points: 1 },
      { id: 'c', text: 'Looking at basic data (sales, expenses)', points: 2 },
      { id: 'd', text: 'Detailed analysis of trends and patterns', points: 3 }
    ]
  },
  {
    id: 'q10',
    section: 'DECISION-MAKING',
    text: 'Q10. When adopting new tools/processes, you:',
    options: [
      { id: 'a', text: 'Wait to see if competitors try it first', points: 0 },
      { id: 'b', text: 'Need to see proof from similar businesses', points: 1 },
      { id: 'c', text: 'Will try if the investment is low', points: 2 },
      { id: 'd', text: 'Are usually an early adopter', points: 3 }
    ]
  },
  {
    id: 'q11',
    section: 'DECISION-MAKING',
    text: 'Q11. Who would implement new technology in your business?',
    options: [
      { id: 'a', text: 'Me personally', points: 2 },
      { id: 'b', text: 'My manager/supervisor', points: 2 },
      { id: 'c', text: 'Would need to hire someone', points: 1 },
      { id: 'd', text: 'Not sure', points: 0 }
    ]
  },
  {
    id: 'q12',
    section: 'DECISION-MAKING',
    text: 'Q12. Are you part of any business association/chamber?',
    options: [
      { id: 'a', text: 'Yes, and I'm active', points: 2 },
      { id: 'b', text: 'Yes, but not very active', points: 1 },
      { id: 'c', text: 'No', points: 0 }
    ]
  }
];

const ACTION_PLANS = {
  tier1: { // 25-35 points - AI Ready
    title: "Your Result: You're Ready to Start",
    messages: [
      "Based on your responses, you have the infrastructure and mindset to implement AI solutions immediately.",

      "*Your Next 30 Days:*\n\n*Week 1-2: Quick Wins*\nStart with the problem costing you the most time or money right now.\n\nIf cash flow is your headache: WhatsApp payment reminder automation (can set up in 2-3 hours)\nIf compliance is killing you: Simple deadline tracking system\nIf equipment breaks down: Start logging failures",

      "*Week 3-4: Prove the Value*\nPick ONE automation to implement. Small, focused, measurable.\n\n*What This Could Look Like:*\nA Surat textile MSME with similar readiness automated their payment reminders on WhatsApp. Result: 8 hours saved weekly, ₹2.5L additional collections in first month. Setup took 2 hours.",

      "*Recommended Next Step:*\n\nOption A (DIY): Download my free toolkit (₹5,000) - 15 automation templates you can implement yourself\n\nOption B (Done-for-you): Book a free audit and I'll tell you exactly which automation to start with and what it will cost\n\nOption C (Strategic): If you're part of a business chamber with 5+ interested members, let's discuss group training where everyone learns together",

      "*The Bottom Line:* You don't need a ₹10 lakh AI transformation. You need one ₹25,000 solution that works, then build from there."
    ]
  },
  tier2: { // 15-24 points - AI Curious
    title: "Your Result: You're in the Perfect Position",
    messages: [
      "You have some digital infrastructure and you recognize where AI could help. What you need isn't technology - it's clarity on what actually works at your scale and budget.",

      "*Your Challenge:*\nYou've probably been burned by expensive software that promised everything and delivered frustration. Or you've avoided it entirely because 'AI is for big companies.' Both are smart instincts.\n\nThe Truth: Most AI implementations fail because they're too complex. The ones that work are stupidly simple.",

      "*Your Next 30 Days:*\n\n*Week 1: Learn What's Possible*\n• 7 AI failures I saw at Amazon (so you avoid them)\n• Self-implementation templates for common tasks\n• Real cost breakdown (what costs ₹5k vs ₹5L)",

      "*Week 2-3: Identify Your One Problem*\nNot five problems. One. The one that costs you the most money or time. Write it down specifically:\n\n'Payment collection takes 15 hours/week'\n'Equipment breakdown cost us ₹8L last year'\n'Compliance deadline missed = ₹2L penalty'",

      "*Week 4: See How Others Did It*\nLook at case studies from businesses like yours.\n\n*Recommended Next Step:*\nBest for you: Free 30-minute audit where I tell you:\n• Can AI actually help your specific problem?\n• What it will realistically cost (I've seen budgets from ₹5k to ₹5L)\n• Whether you should do it yourself or hire someone\n\nNo pitch. Just honest assessment. If AI won't help, I'll tell you.",

      "*The Bottom Line:* You're cautious for good reasons. Let's prove value small before investing big."
    ]
  },
  tier3: { // 0-14 points - AI Explorers
    title: "Your Result: You're Building the Foundation",
    messages: [
      "You're running your business with limited digital infrastructure right now. That's not a weakness - that's where most Indian MSMEs are. But it means AI isn't your immediate priority.",

      "*What You Need First:*\nBefore AI makes sense, you need basic digital systems. Think of it like building a house - you need a foundation before the fancy features.",

      "*Your Next 90 Days:*\n\n*Month 1: Start Tracking Digitally*\nMove one critical process from paper/manual to digital:\n\n• If cash flow is your problem: Track payments in a simple Google Sheet\n• If compliance is messy: Create a calendar with all deadline reminders\n• If equipment breaks unpredictably: Start logging every breakdown (date, what broke, cost)",

      "These aren't AI. These are just good data habits. But they're necessary before AI can help.\n\n*Month 2-3: Identify Patterns*\nOnce you have 60 days of data, patterns emerge:\n\n• Which customers always pay late?\n• Does equipment break down on a schedule?\n• Which compliance deadlines keep sneaking up?",

      "*When You're Ready for AI:*\nOnce you have 3 months of clean data and basic digital workflows, then AI makes sense. It needs good data to work with.\n\n*Recommended Next Step:*\nDownload my free tracking templates and start building your data foundation. If this feels overwhelming, book a free 30-minute call and I'll tell you the simplest place to start.",

      "*The Bottom Line:* You're not behind. You're being smart about building systematically. AI will make sense for you in 6-12 months, once you have the foundation in place.\n\n*In the meantime:*\n• Track one key metric digitally (revenue, inventory, breakdowns)\n• Move to WhatsApp Business for customer communication (free, simple)\n• Consider Tally or basic accounting software if you're still paper-based"
    ]
  }
};

if (!SEND_API_KEY) {
  console.error("Missing SEND_API_KEY - aborting.");
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

function hasUserBeenContacted(phoneNumber) {
  const userKey = normalizePhone(phoneNumber);
  return userInteractionCache.has(userKey);
}

function markUserContacted(phoneNumber, interactionType = 'survey_started') {
  const userKey = normalizePhone(phoneNumber);
  const userData = userInteractionCache.get(userKey) || {
    firstContact: Date.now(),
    interactions: []
  };

  userData.interactions.push({ type: interactionType, timestamp: Date.now() });
  userInteractionCache.set(userKey, userData);
  return userData;
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
    case 'survey_question':
      await sendSurveyQuestion(phoneNumber, data.questionIndex);
      console.log(`Sent survey question ${data.questionIndex} to ${phoneNumber}`);
      break;
    case 'text_message':
      await sendTextOnce(phoneNumber, data.text, TEXT_TIMEOUT_MS);
      console.log(`Sent text message to ${phoneNumber}`);
      break;
    default:
      console.warn(`Unknown message type: ${messageType}`);
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

/* -------- SURVEY FUNCTIONS -------- */

async function sendInteractiveButtons(toPhone, bodyText, buttons, footerText = null) {
  const trace = createRequestTrace('interactive', toPhone, { body: bodyText, buttons });
  const fingerprint = createMessageFingerprint(toPhone, { body: bodyText, buttons }, 'interactive');

  if (sentCache.get(fingerprint)) {
    console.log(`TRACE ${trace.id}: sendInteractiveButtons SKIPPED (fingerprint: ${fingerprint})`, toPhone);
    return { skipped: true, fingerprint };
  }

  const headers = {
    Authorization: `Bearer ${SEND_API_KEY}`,
    "Content-Type": "application/json",
    "X-Request-Id": trace.id
  };

  // WHAPI interactive message format
  const payload = {
    to: String(toPhone),
    type: "button",
    body: {
      text: String(bodyText)
    },
    action: {
      buttons: buttons.map((btn, idx) => ({
        type: "reply",
        reply: {
          id: btn.id || `btn_${idx}`,
          title: btn.text.substring(0, 20) // WhatsApp limit
        }
      }))
    }
  };

  if (footerText) {
    payload.footer = { text: String(footerText) };
  }

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

function getSurveyState(phoneNumber) {
  const userKey = normalizePhone(phoneNumber);
  return surveyStateCache.get(userKey);
}

function updateSurveyState(phoneNumber, state) {
  const userKey = normalizePhone(phoneNumber);
  surveyStateCache.set(userKey, state);
  console.log(`Survey state updated for ${phoneNumber}: Question ${state.currentQuestion}, Score ${state.totalScore}`);
}

function initializeSurvey(phoneNumber) {
  const state = {
    active: true,
    currentQuestion: 0,
    answers: [],
    totalScore: 0,
    startedAt: Date.now()
  };
  updateSurveyState(phoneNumber, state);
  return state;
}

async function sendSurveyQuestion(phoneNumber, questionIndex) {
  const question = SURVEY_QUESTIONS[questionIndex];
  if (!question) {
    console.error(`Question ${questionIndex} not found`);
    return;
  }

  const sectionHeader = questionIndex === 0 || SURVEY_QUESTIONS[questionIndex - 1]?.section !== question.section
    ? `\n*SECTION: ${question.section}*\n\n`
    : '';

  const bodyText = `${sectionHeader}${question.text}${question.multiSelect ? '\n(You can select multiple)' : ''}`;

  if (question.openText) {
    // For open text questions, just send a regular text message
    await sendTextOnce(phoneNumber, `${bodyText}\n\nPlease type your answer:`, TEXT_TIMEOUT_MS);
  } else {
    // Send interactive buttons
    const buttons = question.options.map(opt => ({
      id: `${question.id}_${opt.id}`,
      text: opt.text
    }));

    const footerText = `Question ${questionIndex + 1} of ${SURVEY_QUESTIONS.length}`;
    await sendInteractiveButtons(phoneNumber, bodyText, buttons, footerText);
  }
}

function calculateScore(questionId, selectedOptions) {
  const question = SURVEY_QUESTIONS.find(q => q.id === questionId);
  if (!question) return 0;

  if (question.openText) {
    return 0; // Open text doesn't contribute to score
  }

  if (question.multiSelect) {
    // For multi-select, sum up points but cap at maxPoints
    const points = selectedOptions.reduce((sum, optId) => {
      const option = question.options.find(o => o.id === optId);
      return sum + (option?.points || 0);
    }, 0);
    return Math.min(points, question.maxPoints || points);
  } else {
    // Single select
    const option = question.options.find(o => o.id === selectedOptions[0]);
    return option?.points || 0;
  }
}

function getTierFromScore(score) {
  if (score >= 25) return 'tier1'; // AI Ready
  if (score >= 15) return 'tier2'; // AI Curious
  return 'tier3'; // AI Explorers
}

async function sendActionPlan(phoneNumber, score) {
  const tier = getTierFromScore(score);
  const plan = ACTION_PLANS[tier];

  // Send title first
  await queueMessage(phoneNumber, 'text_message', {
    text: `*${plan.title}*\n\nYour Score: ${score}/35 points`
  });

  // Queue all messages with delays
  for (let i = 0; i < plan.messages.length; i++) {
    await sleep(500); // Small delay between queuing
    await queueMessage(phoneNumber, 'text_message', {
      text: plan.messages[i]
    });
  }

  console.log(`Action plan (${tier}) queued for ${phoneNumber} with score ${score}`);
}

async function handleSurveyResponse(phoneNumber, buttonId, messageText) {
  const state = getSurveyState(phoneNumber);

  if (!state || !state.active) {
    console.log(`No active survey for ${phoneNumber}`);
    return false;
  }

  const currentQuestion = SURVEY_QUESTIONS[state.currentQuestion];

  if (currentQuestion.openText) {
    // Handle open text response
    state.answers.push({
      questionId: currentQuestion.id,
      answer: messageText,
      points: 0
    });
  } else {
    // Handle button response
    if (!buttonId || !buttonId.startsWith(currentQuestion.id)) {
      console.log(`Button ID ${buttonId} doesn't match current question ${currentQuestion.id}`);
      return false;
    }

    const optionId = buttonId.split('_')[1]; // Extract option id from button id
    const points = calculateScore(currentQuestion.id, [optionId]);

    state.answers.push({
      questionId: currentQuestion.id,
      selectedOptions: [optionId],
      points
    });

    state.totalScore += points;
  }

  // Move to next question
  state.currentQuestion++;

  if (state.currentQuestion < SURVEY_QUESTIONS.length) {
    // More questions to go
    updateSurveyState(phoneNumber, state);

    // Queue next question with delay
    await queueMessage(phoneNumber, 'survey_question', {
      questionIndex: state.currentQuestion
    });

    return true;
  } else {
    // Survey completed
    state.active = false;
    state.completedAt = Date.now();
    updateSurveyState(phoneNumber, state);

    console.log(`Survey completed for ${phoneNumber}. Final score: ${state.totalScore}`);

    // Send completion message and action plan
    await queueMessage(phoneNumber, 'text_message', {
      text: "Thank you for completing the assessment! Let me calculate your results..."
    });

    await sleep(1000);
    await sendActionPlan(phoneNumber, state.totalScore);

    return true;
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
      buttonResponse: m?.interactive?.button_reply?.id || m?.button_reply?.id || null,
      raw: m
    };
  }
  if (body.message) {
    const m = body.message;
    return {
      kind: "message",
      messageId: m.id || null,
      from: m.from || m.sender || null,
      from_me: !!m.from_me,
      text: m?.text?.body || m?.body || null,
      buttonResponse: m?.interactive?.button_reply?.id || m?.button_reply?.id || null,
      raw: m
    };
  }
  return { kind: "unknown", raw: body };
}



/* -------- ADMIN endpoints -------- */
app.get("/admin/survey-stats", (req, res) => {
  if (ADMIN_KEY) {
    const key = req.headers["x-admin-key"];
    if (!key || key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "invalid admin key" });
  }

  // Collect survey statistics
  let activeCount = 0;
  let completedCount = 0;
  const tierCounts = { tier1: 0, tier2: 0, tier3: 0 };

  surveyStateCache.forEach((state, key) => {
    if (state.active) {
      activeCount++;
    } else if (state.completedAt) {
      completedCount++;
      const tier = getTierFromScore(state.totalScore);
      tierCounts[tier]++;
    }
  });

  return res.json({
    ok: true,
    activeSurveys: activeCount,
    completedSurveys: completedCount,
    tierDistribution: tierCounts,
    queueDepth: messageQueue.length
  });
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

    // -------- SURVEY FLOW --------
    // Check if user has an active survey
    const surveyState = getSurveyState(from);
    if (surveyState && surveyState.active) {
      console.log(`Active survey detected for ${from} - handling response`);
      const handled = await handleSurveyResponse(from, incoming.buttonResponse, incoming.text);
      if (handled) {
        return res.status(200).send("survey-response-handled");
      }
    }

    // Check for "mining" keyword to start new survey
    if (incoming.text && incoming.text.toLowerCase().trim() === 'mining') {
      console.log(`Mining keyword detected from ${from} - starting survey`);

      // Initialize survey
      initializeSurvey(from);

      // Mark user as contacted so they don't get the PDF
      markUserContacted(from, 'survey_started');

      // Queue welcome message and first question
      await queueMessage(from, 'text_message', {
        text: "Welcome to the MSME AI Readiness Assessment! 📊\n\nThis will take about 5 minutes and help us understand how AI can best serve your business.\n\nLet's get started!"
      });

      await sleep(500);
      await queueMessage(from, 'survey_question', {
        questionIndex: 0
      });

      return res.status(200).send("survey-started");
    }

    // New user or non-survey message - send instruction
    if (!hasUserBeenContacted(from)) {
      console.log(`New user ${from} - sending survey instructions`);

      // Mark user as contacted so they don't get this message again
      markUserContacted(from, 'instructed');

      await queueMessage(from, 'text_message', {
        text: "👋 Hello! Welcome to the MSME AI Readiness Assessment.\n\nTo discover how AI can transform your business, type *mining* to start the assessment."
      });

      return res.status(200).send("instructions-sent");
    } else {
      console.log(`User ${from} sent message but not a survey command - ignoring`);
      return res.status(200).send("ignored-not-survey");
    }
  } catch (err) {
    console.error("Unhandled webhook error:", err);
    return res.status(500).send("internal-error");
  }
});

/* -------- START -------- */
app.listen(PORT, () => console.log(`Server listening ${PORT}`));
