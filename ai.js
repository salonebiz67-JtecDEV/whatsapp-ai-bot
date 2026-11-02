import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';

let genAI = null;
let currentModelName = null;

function initGemini(modelName, systemPrompt) {
  if (!config.geminiApiKey) throw new Error('No Gemini key');
  const targetModel = modelName || config.geminiModel;
  if (!genAI || currentModelName !== targetModel) {
    genAI = new GoogleGenerativeAI(config.geminiApiKey);
    currentModelName = targetModel;
  }
  return genAI.getGenerativeModel({ model: targetModel, systemInstruction: systemPrompt });
}

async function callOpenAICompatible({ apiKey, baseUrl, model, messages, providerName, extraHeaders = {} }) {
  if (!apiKey) throw new Error(`No ${providerName} key`);
  console.log(`🧠 Trying ${providerName} ${model}...`);
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ model, messages, max_tokens: 500, temperature: 0.8 }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`${providerName} ${res.status}: ${(await res.text()).slice(0,300)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || data.choices?.[0]?.text;
  if (!text) throw new Error(`Empty ${providerName}`);
  console.log(`✅ ${providerName} replied`);
  return text.trim();
}

function buildMessages(userMessage, history, ownerStyleSamples, systemPrompt, imagePart = null) {
  let safeStyle = [];
  if (ownerStyleSamples && ownerStyleSamples.length > 0) {
    safeStyle = ownerStyleSamples.filter(s => {
      const lower = s.toLowerCase();
      return !containsFinancialLanguage(lower, true) && !containsRomanticLanguage(lower, true);
    }).slice(-8);
  }
  
  let dynamicPrompt = systemPrompt;
  if (safeStyle.length > 0) {
    const styleExamples = safeStyle.join('\n- ');
    dynamicPrompt += `\n\nCasual tone reference (how owner normally does small talk, but DO NOT copy flirty/romantic tone):\n- ${styleExamples}`;
  }
  
  const msgs = [
    { role: 'system', content: dynamicPrompt },
    ...history.slice(-10).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content.slice(0, 800) })),
  ];
  if (imagePart) msgs.push({ role: 'user', content: [{ type: 'text', text: userMessage }, imagePart] });
  else msgs.push({ role: 'user', content: userMessage });
  return msgs;
}

// ==================== HARD FILTERS & SAFETY CHECKS ====================

// Whole-word matching so "ill" doesn't match "will", "pos" doesn't match "possible", "sue" doesn't match "issue"
function kwMatch(lower, kw) {
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])', 'i').test(lower);
}


// 1. FINANCIAL LANGUAGE - HARD BLOCK
const FINANCIAL_KEYWORDS = [
  'account number', 'acct number', 'account no', 'acct no', 'a/c number',
  'bank account', 'account details', 'bank details', 'account info',
  'opay', 'palmpay', 'moniepoint', 'kuda', 'first bank', 'gtb', 'gtbank', 'access bank', 'uba', 'zenith',
  'send money', 'send me money', 'transfer money', 'make transfer', 'do transfer',
  'send account', 'drop account', 'send aza', 'drop aza', 'send your aza',
  'send funds', 'drop funds', 'send cash', 'drop cash',
  'bank transfer', 'wire transfer', 'money transfer',
  'payment', 'pay me', 'pay you', 'make payment',
  'naira', '₦', 'kobo', 'dollar', 'usd',
  'wallet', 'pos', 'transaction', 'remit', 'remittance'
];

const FINANCIAL_REGEXES = [
  /\b\d{10}\b/, // 10 digit account number
  /\b\d{11}\b.*\b(opay|bank|account)\b/i,
  /\b(send|drop|transfer).{0,20}(money|cash|fund|account|aza|naira|₦)/i,
  /\b(account|aza).{0,10}(number|details|no)\b/i,
  /\b(opay|palmpay|moniepoint|kuda|bank).{0,15}\d{6,}/i,
];

export function containsFinancialLanguage(text, isStyleCheck = false) {
  if (!text) return false;
  const lower = text.toLowerCase();
  
  for (const kw of FINANCIAL_KEYWORDS) {
    if (kwMatch(lower, kw)) {
      if (isStyleCheck) {
        if (['account number', 'acct number', 'send money', 'transfer money', 'send account', 'drop account', 'send aza', 'drop aza', 'opay', 'bank account'].some(k => lower.includes(k))) {
          return true;
        }
        continue;
      }
      console.log(`🚫 Financial keyword blocked: "${kw}" in "${text.slice(0,80)}"`);
      return true;
    }
  }
  
  if (!isStyleCheck) {
    for (const regex of FINANCIAL_REGEXES) {
      if (regex.test(text)) {
        console.log(`🚫 Financial regex blocked: ${regex} in "${text.slice(0,80)}"`);
        return true;
      }
    }
  }
  
  return false;
}

// 2. ROMANTIC/FLIRTY LANGUAGE - HARD BLOCK
const ROMANTIC_EMOJIS = ['🥰', '😍', '💞', '😘', '💋', '💖', '💗', '💓', '💘', '💝', '💟', '❤️‍🔥', '😻', '😽', '🫦', '👄'];
const ROMANTIC_KEYWORDS = [
  'my love', 'my lover', 'my baby', 'my babe', 'my sweetheart', 'my honey', 'my darling', 'my boo',
  'i love you', 'love you so much', 'love u so much', 'luv u', 'ily',
  'miss you so much', 'miss u so much', 'thinking of you', 'can\'t stop thinking',
  'you\'re my everything', 'you are my everything', 'my everything',
  'my heart', 'my world', 'my queen', 'my king',
  'sexy', 'hot babe', 'hot baby', 'fine babe', 'fine girl', 'fine boy',
  'kiss you', 'hug you tight', 'cuddle', 'make love',
  'babe i', 'baby i', 'sweetie', 'cutie', 'boo boo'
];

const ROMANTIC_REGEXES = [
  /\b(babe|baby|boo|honey|sweetheart|darling)\b.*\b(love|miss|kiss|hug|cuddle)\b/i,
  /\b(i|you).{0,5}\b(my|ur)\b.{0,5}\b(love|heart|everything|world)\b/i,
  /😍|🥰|💞|😘|💋|💖|💘/,
];

export function containsRomanticLanguage(text, isStyleCheck = false) {
  if (!text) return false;
  const lower = text.toLowerCase();
  
  for (const emoji of ROMANTIC_EMOJIS) {
    if (text.includes(emoji)) {
      console.log(`🚫 Romantic emoji blocked: ${emoji} in "${text.slice(0,80)}"`);
      return true;
    }
  }
  
  for (const kw of ROMANTIC_KEYWORDS) {
    if (kwMatch(lower, kw)) {
      if (isStyleCheck && !['i love you', 'my love', 'sexy', 'make love'].includes(kw)) {
        continue;
      }
      console.log(`🚫 Romantic keyword blocked: "${kw}" in "${text.slice(0,80)}"`);
      return true;
    }
  }
  
  if (!isStyleCheck) {
    for (const regex of ROMANTIC_REGEXES) {
      if (regex.test(text)) {
        console.log(`🚫 Romantic regex blocked: ${regex} in "${text.slice(0,80)}"`);
        return true;
      }
    }
  }
  
  return false;
}

export function sanitizeRomanticLanguage(text) {
  if (!text) return text;
  let sanitized = text;
  for (const emoji of ROMANTIC_EMOJIS) {
    sanitized = sanitized.split(emoji).join('');
  }
  sanitized = sanitized.replace(/\b(my love|my baby|my babe|babe|baby|boo|honey|sweetheart)\b/gi, 'there');
  sanitized = sanitized.replace(/😍|🥰|💞|😘|💋|💖|💗|💓|💘|💝/g, '🙂');
  return sanitized.trim();
}

// 3. IDENTITY / DISCLOSURE CHECK
const IDENTITY_QUESTIONS = [
  'are you a bot', 'are you bot', 'are you an ai', 'are you ai', 'are you automated',
  'is this a bot', 'is this bot', 'is this an ai', 'is this ai', 'is this automated',
  'are you real', 'are you really you', 'is this really you',
  'who is this', 'who are you really', 'are you human', 'are you a human', 'are you a person',
  'bot?', 'automated?', 'ai assistant', 'you a robot'
];

export function isIdentityQuestion(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  
  for (const q of IDENTITY_QUESTIONS) {
    if (lower.includes(q)) {
      console.log(`🔍 Identity question detected: "${q}" in "${text.slice(0,80)}"`);
      return true;
    }
  }
  
  const o = (config.ownerName || '').toLowerCase();
  if (o && (lower.includes(`are you ${o}`) || lower.includes(`is this ${o}`) || lower.includes(`real ${o}`) || lower.includes(`talking to ${o}`) || lower.includes(`is this really ${o}`))) return true;
  if (/\b(is|are|am).{0,10}\b(really|actually|truly).{0,10}\b(you|him|her)\b/i.test(lower)) return true;
  if (/\b(bot|ai|automated|robot)\b/i.test(lower) && /\b(you|this|are|is)\b/i.test(lower)) return true;
  
  return false;
}

export function getDisclosureResponse() {
  return `Yes, I'm ${config.assistantName}, ${config.ownerName}'s AI assistant 🙂 I handle messages for ${config.ownerName} and I'll pass anything important on to them directly. How can I help?`;
}

// 4. SERIOUS TOPICS - AUTO HANDOFF (kept narrow on purpose: only real emergencies/crises, so normal chats still get replies)
const SERIOUS_KEYWORDS = [
  'suicidal', 'suicide', 'kill myself', 'want to die', 'self harm', 'self-harm', 'cutting myself',
  'emergency', 'hospital', 'accident', 'passed away', 'funeral', 'miscarriage',
  'arrested', 'lawsuit', 'kidnapped', 'rape', 'raped', 'abuse', 'abused'
];

const SERIOUS_REGEXES = [
  /\b(i need|need).{0,15}\b(you|help|advice|talk)\b.*\b(serious|urgent|important)\b/i,
];

export function isSeriousTopic(text, history = []) {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const kw of SERIOUS_KEYWORDS) {
    if (kwMatch(lower, kw)) {
      console.log(`⚠️ Serious keyword detected: "${kw}" in "${text.slice(0,80)}" - triggering handoff`);
      return true;
    }
  }
  for (const regex of SERIOUS_REGEXES) {
    if (regex.test(text)) {
      console.log(`⚠️ Serious regex detected: ${regex} - triggering handoff`);
      return true;
    }
  }
  return false;
}

export function getHandoffResponse(contactName = 'there') {
  return `Thanks for telling me. This sounds important, so I'll pass this to ${config.ownerName} right now and they'll reply you personally. 🙏`;
}

export function getSafeFallbackResponse() {
  const fallbacks = [
    `Got it, I'll pass this to ${config.ownerName} so they reply you directly. 🙏`,
    `Thanks for letting me know. I'll make sure ${config.ownerName} sees this and gets back to you.`,
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

export function getNigerianTimeContext() {
  try {
    const now = new Date();
    const options = { timeZone: 'Africa/Lagos', hour12: true, hour: 'numeric', minute: '2-digit', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const full = now.toLocaleString('en-NG', options);
    const hour24 = parseInt(now.toLocaleString('en-US', { timeZone: 'Africa/Lagos', hour: 'numeric', hour12: false }));
    const hour12 = now.toLocaleString('en-US', { timeZone: 'Africa/Lagos', hour: 'numeric', hour12: true });
    const minute = now.toLocaleString('en-US', { timeZone: 'Africa/Lagos', minute: '2-digit' });
    
    let period = '';
    let greeting = '';
    let greetingInstruction = '';
    
    if (hour24 >= 0 && hour24 < 5) {
      period = 'late night / early morning (12am - 4:59am)';
      greeting = 'Hello';
      greetingInstruction = `It's ${hour12}:${minute} AM WAT - very late night/early morning. Use neutral "Hello" not time-specific greeting.`;
    } else if (hour24 >= 5 && hour24 < 12) {
      period = 'morning (5am - 11:59am)';
      greeting = 'Good morning';
      greetingInstruction = `It's morning ${hour12}:${minute} AM WAT. Use "Good morning".`;
    } else if (hour24 >= 12 && hour24 < 16) {
      period = 'afternoon (12pm - 3:59pm)';
      greeting = 'Good afternoon';
      greetingInstruction = `It's afternoon ${hour12}:${minute} PM WAT. Use "Good afternoon".`;
    } else if (hour24 >= 16 && hour24 < 19) {
      period = 'evening (4pm - 6:59pm)';
      greeting = 'Good evening';
      greetingInstruction = `It's evening ${hour12}:${minute} PM WAT. Use "Good evening".`;
    } else {
      period = 'night (7pm - 11:59pm)';
      greeting = 'Good evening';
      greetingInstruction = `It's night ${hour12}:${minute} PM WAT. Use "Good evening".`;
    }
    
    return {
      full,
      hour24,
      hour12: `${hour12}:${minute}`,
      period,
      greeting,
      greetingInstruction,
      formatted: `Current Nigerian time: ${full} (Africa/Lagos WAT). Period: ${period}. Appropriate greeting: ${greeting}. ${greetingInstruction}`
    };
  } catch (e) {
    console.error('Time context error:', e.message);
    return {
      full: new Date().toISOString(),
      hour24: new Date().getHours(),
      period: 'unknown',
      greeting: 'Hello',
      greetingInstruction: 'Use neutral Hello greeting',
      formatted: `Current time: ${new Date().toLocaleString()} - Use neutral greeting`
    };
  }
}

export async function generateReply(jid, userMessage, history = [], ownerStyleSamples = null, mediaInfo = null, options = {}) {
  const lowerMsg = (userMessage || '').toLowerCase();
  
  // ===== MANDATORY CHECKS BEFORE AI =====
  const skipPreChecks = options.skipPreChecks || options.isAgentTask || false;
  const isInternalAgentPrompt = userMessage && (userMessage.includes('Goal for this contact:') || userMessage.includes('STRICT RULES:') || userMessage.includes('AGENT OUTREACH:'));
  
  // 1. Identity question -> must disclose truthfully (skip for internal prompts)
  if (!isInternalAgentPrompt && !skipPreChecks && isIdentityQuestion(userMessage)) {
    console.log(`🔍 IDENTITY QUESTION from ${jid}: "${userMessage.slice(0,80)}" - DISCLOSING`);
    return getDisclosureResponse();
  }
  
  // 2. Serious topics -> auto handoff
  if (!isInternalAgentPrompt && !skipPreChecks && isSeriousTopic(userMessage, history)) {
    console.log(`⚠️ SERIOUS TOPIC from ${jid}: "${userMessage.slice(0,80)}" - HANDOFF REQUIRED`);
    return `__HANDOFF__${getHandoffResponse()}`;
  }
  
  // 3. Financial request from user -> handoff
  if (!isInternalAgentPrompt && !skipPreChecks) {
    const lower = (userMessage || '').toLowerCase();
    const isFinancialRequest = /\b(send|transfer|drop).{0,15}(money|account|aza|cash|fund)/i.test(lower) || 
                               /\b(account number|bank account|opay|my account|your account).{0,10}(please|send|drop|what|give)/i.test(lower) ||
                               /\b(what is|send me|give me).{0,10}(account|opay|bank)/i.test(lower);
    if (isFinancialRequest || (containsFinancialLanguage(userMessage) && lower.length < 100 && (lower.includes('?') || lower.includes('please') || lower.includes('send') || lower.includes('give')))) {
      console.log(`💰 Financial request from ${jid}: "${userMessage.slice(0,80)}" - HANDOFF, no financial handling`);
      return `__HANDOFF__${getHandoffResponse()} __REASON__: Financial topic`;
    }
  }

  const isNewContact = !ownerStyleSamples || ownerStyleSamples.length === 0;
  let dynamicSystemPrompt = '';

  const timeContext = getNigerianTimeContext();
  console.log(`⏰ Nigerian time: ${timeContext.formatted}`);
  
  const shouldDisclose = options.shouldDisclose || false;
  const isForcedDisclosure = options.isForcedDisclosure || false;
  console.log(`📢 Disclosure check for ${jid}: shouldDisclose=${shouldDisclose}, forced=${isForcedDisclosure}, newContact=${!ownerStyleSamples || ownerStyleSamples.length === 0}`);

  // ===== YOUR ASSISTANT'S IDENTITY + RULES (env vars: OWNER_NAME, ASSISTANT_NAME, PERSONA, GOALS, LANGUAGE_STYLE, CUSTOM_RULES) =====
  const OWNER = config.ownerName;
  const BOT = config.assistantName;
  const disclosureInstruction = shouldDisclose
    ? `Include ONE short natural sentence saying you are ${BOT}, ${OWNER}'s AI assistant, then carry on helping.`
    : `You already introduced yourself to this contact. Do NOT re-introduce yourself, just continue naturally.`;

  const safeStyle = (ownerStyleSamples || []).filter(s => !containsFinancialLanguage(s, true) && !containsRomanticLanguage(s, true)).slice(-6);

  dynamicSystemPrompt = `
You are ${BOT}, an AI assistant that answers WhatsApp messages on behalf of ${OWNER}. You are an AI, not ${OWNER}.

PERSONALITY:
${config.persona}

LANGUAGE STYLE:
${config.languageStyle}

YOUR GOALS:
${config.goals}
${config.customRules ? `\nEXTRA RULES:\n${config.customRules}\n` : ''}
CORE RULES (never break):
1. Reply to every message. Never ignore anyone. Keep replies short (1-3 short lines) unless they ask for detail.
2. Honesty: if anyone sincerely asks whether you are a bot, AI, human, or ${OWNER}, say plainly that you are ${BOT}, ${OWNER}'s AI assistant. Never claim to be human or to be ${OWNER}.
3. Never make promises, payments or commitments for ${OWNER}. Never share or ask for bank/account details or money. If money, legal or an urgent personal matter comes up, say you'll pass it to ${OWNER}.
4. No romantic or flirty tone.
5. If you don't know something, say so and offer to pass a message to ${OWNER}. Never invent facts about ${OWNER}.
6. ${disclosureInstruction}

${safeStyle.length ? `How ${OWNER} usually chats (tone reference only, don't copy romantic/financial lines):\n- ${safeStyle.join('\n- ')}\n` : ''}${isNewContact ? 'This is a new contact.' : 'You have chatted with this contact before.'}
Time: ${timeContext.formatted} - use "${timeContext.greeting}" if you greet.
`;
  console.log(`🧠 ${isNewContact ? 'NEW' : 'KNOWN'} contact ${jid} - ${BOT} for ${OWNER} - disclose=${shouldDisclose}`);

  if (mediaInfo) {
    if (mediaInfo.type === 'image') {
      dynamicSystemPrompt += `\nUSER SENT IMAGE${mediaInfo.caption ? ` caption: "${mediaInfo.caption}"` : ''}. React casually and lightly as assistant.`;
      if (!userMessage || userMessage === '[Image]' || userMessage.startsWith('[Image')) userMessage = mediaInfo.caption || "Thanks for sharing this image 🙂";
    } else if (mediaInfo.type === 'sticker') {
      dynamicSystemPrompt += `\nUSER SENT STICKER. React lightly with humor, friendly, no flirty tone.`;
      if (!userMessage || userMessage === '[Sticker]') userMessage = "Nice sticker 😊";
    } else if (mediaInfo.type === 'video') {
      if (mediaInfo.transcription) {
        dynamicSystemPrompt += `\nUSER SENT VIDEO with audio: "${mediaInfo.transcription}"${mediaInfo.caption ? ` caption: "${mediaInfo.caption}"` : ''}. Respond casually to content, but if serious/personal -> handoff.`;
        if (!userMessage || userMessage.startsWith('[Video')) userMessage = mediaInfo.transcription;
      } else {
        dynamicSystemPrompt += `\nUSER SENT VIDEO${mediaInfo.caption ? ` caption: "${mediaInfo.caption}"` : ''}. React lightly.`;
        userMessage = mediaInfo.caption || userMessage || "See this video";
      }
    } else if (mediaInfo.type === 'voice' || mediaInfo.type === 'audio') {
      if (mediaInfo.transcription) {
        dynamicSystemPrompt += `\nUSER SENT VOICE NOTE: "${mediaInfo.transcription}". Respond casually to content, but check if serious -> handoff.`;
        if (!userMessage || userMessage === '[Voice note]' || userMessage === '[Audio]') userMessage = mediaInfo.transcription;
      } else {
        dynamicSystemPrompt += `\nUSER SENT VOICE NOTE but transcription failed. Acknowledge lightly and ask them to type if important.`;
        userMessage = userMessage || "Voice note received";
      }
    }
  }

  let imagePartForOpenAI = null;
  let imagePartForGemini = null;
  if (mediaInfo && mediaInfo.base64) {
    imagePartForOpenAI = { type: 'image_url', image_url: { url: `data:${mediaInfo.mimeType};base64,${mediaInfo.base64}` } };
    imagePartForGemini = { inlineData: { data: mediaInfo.base64, mimeType: mediaInfo.mimeType } };
  }

  const modelsToTry = [config.geminiModel || 'gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest'];
  const uniqueModels = [...new Set(modelsToTry)];
  let lastError = null;
  let generatedReply = null;

  for (const modelName of uniqueModels) {
    if (!config.geminiApiKey) break;
    try {
      const m = initGemini(modelName, dynamicSystemPrompt);
      const _send = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('Gemini timeout 20s')), 20000))]);
      let geminiHistory = history.slice(-config.maxHistory).filter(msg => msg.role !== 'system' && msg.content && msg.content.trim().length > 0).map(msg => ({ role: msg.role === 'user' ? 'user' : 'model', parts: [{ text: msg.con
