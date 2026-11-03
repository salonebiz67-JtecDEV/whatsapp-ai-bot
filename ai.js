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
  // NEW: Transparent assistant - no longer impersonating, no bank info in prompt
  // Style samples are used ONLY for casual tone reference, but filtered for romantic/financial content
  let safeStyle = [];
  if (ownerStyleSamples && ownerStyleSamples.length > 0) {
    // Filter out any style samples that contain financial or romantic language to prevent learning bad patterns
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
  
  // Check keywords
  for (const kw of FINANCIAL_KEYWORDS) {
    if (kwMatch(lower, kw)) {
      // For style check, be less aggressive - only block obvious ones
      if (isStyleCheck) {
        // Only block if contains account number patterns or explicit money requests
        if (['account number', 'acct number', 'send money', 'transfer money', 'send account', 'drop account', 'send aza', 'drop aza', 'opay', 'bank account'].some(k => lower.includes(k))) {
          return true;
        }
        continue;
      }
      console.log(`🚫 Financial keyword blocked: "${kw}" in "${text.slice(0,80)}"`);
      return true;
    }
  }
  
  // Check regexes (always for AI output, not for style check unless obvious)
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

// Romantic phrases that are intimate - check with word boundaries
const ROMANTIC_REGEXES = [
  /\b(babe|baby|boo|honey|sweetheart|darling)\b.*\b(love|miss|kiss|hug|cuddle)\b/i,
  /\b(i|you).{0,5}\b(my|ur)\b.{0,5}\b(love|heart|everything|world)\b/i,
  /😍|🥰|💞|😘|💋|💖|💘/,
];

export function containsRomanticLanguage(text, isStyleCheck = false) {
  if (!text) return false;
  const lower = text.toLowerCase();
  
  // Check emojis
  for (const emoji of ROMANTIC_EMOJIS) {
    if (text.includes(emoji)) {
      console.log(`🚫 Romantic emoji blocked: ${emoji} in "${text.slice(0,80)}"`);
      return true;
    }
  }
  
  // Check keywords - for style check, be more permissive, only block explicit
  for (const kw of ROMANTIC_KEYWORDS) {
    if (kwMatch(lower, kw)) {
      if (isStyleCheck && !['i love you', 'my love', 'sexy', 'make love'].includes(kw)) {
        continue; // Allow some mild terms in style learning, but filter in output
      }
      console.log(`🚫 Romantic keyword blocked: "${kw}" in "${text.slice(0,80)}"`);
      return true;
    }
  }
  
  // Regex check for AI output
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
  // Remove romantic emojis
  for (const emoji of ROMANTIC_EMOJIS) {
    sanitized = sanitized.split(emoji).join('');
  }
  // Replace romantic phrases with neutral
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
  
  // Direct match
  for (const q of IDENTITY_QUESTIONS) {
    if (lower.includes(q)) {
      console.log(`🔍 Identity question detected: "${q}" in "${text.slice(0,80)}"`);
      return true;
    }
  }
  
  const o = (config.ownerName || '').toLowerCase();
  if (o && (lower.includes(`are you ${o}`) || lower.includes(`is this ${o}`) || lower.includes(`real ${o}`) || lower.includes(`talking to ${o}`) || lower.includes(`is this really ${o}`))) return true;
  // Pattern match: "is this really you" variations
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
  
  // 2. Serious/personal/emotional/important -> auto handoff, don't reply as bot (skip for internal agent prompts)
  if (!isInternalAgentPrompt && !skipPreChecks && isSeriousTopic(userMessage, history)) {
    console.log(`⚠️ SERIOUS TOPIC from ${jid}: "${userMessage.slice(0,80)}" - HANDOFF REQUIRED`);
    return `__HANDOFF__${getHandoffResponse()}`;
  }
  
  // 3. Financial request from user -> handoff (don't handle money) - strict for real user messages, not internal prompts
  if (!isInternalAgentPrompt && !skipPreChecks) {
    // Only check if user is actually REQUESTING financial action, not just mentioning keywords in instructions
    // Use more specific check for user financial requests
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
  
  // Disclosure frequency logic
  const shouldDisclose = options.shouldDisclose || false;
  const isForcedDisclosure = options.isForcedDisclosure || false; // Identity question
  console.log(`📢 Disclosure check for ${jid}: shouldDisclose=${shouldDisclose}, forced=${isForcedDisclosure}, newContact=${!ownerStyleSamples || ownerStyleSamples.length === 0}`);

  // ===== YOUR ASSISTANT'S IDENTITY + RULES (edit via env vars: OWNER_NAME, ASSISTANT_NAME, PERSONA, GOALS, LANGUAGE_STYLE, CUSTOM_RULES) =====
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
      let geminiHistory = history.slice(-config.maxHistory).filter(msg => msg.role !== 'system' && msg.content && msg.content.trim().length > 0).map(msg => ({ role: msg.role === 'user' ? 'user' : 'model', parts: [{ text: msg.content.slice(0, 1000) }] }));
      while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') geminiHistory.shift();
      const cleaned = [];
      for (let i = 0; i < geminiHistory.length; i++) {
        const curr = geminiHistory[i];
        if (cleaned.length > 0 && cleaned[cleaned.length-1].role === curr.role) cleaned[cleaned.length-1].parts[0].text += '\n' + curr.parts[0].text;
        else cleaned.push(curr);
      }
      geminiHistory = cleaned;
      if (imagePartForGemini && mediaInfo?.type === 'image') {
        console.log(`🧠 Asking ${modelName} with IMAGE for ${jid} (${isNewContact ? 'NEW' : 'KNOWN'})`);
        const result = await _send(m.generateContent({ contents: [...geminiHistory.map(h => ({ role: h.role, parts: h.parts })), { role: 'user', parts: [{ text: userMessage }, imagePartForGemini] }], generationConfig: { maxOutputTokens: 1024, temperature: 0.6, topP: 0.9 } }));
        const text = result.response.text();
        if (!text) throw new Error('Empty');
        generatedReply = text.trim();
        break;
      } else {
        const chat = m.startChat({ history: geminiHistory, generationConfig: { maxOutputTokens: 1024, temperature: 0.6, topP: 0.9 } });
        console.log(`🧠 Asking ${modelName} for ${jid} (${isNewContact ? 'NEW' : 'KNOWN'}, history: ${geminiHistory.length})`);
        const result = await _send(chat.sendMessage(userMessage));
        const text = result.response.text();
        if (!text) throw new Error('Empty');
        generatedReply = text.trim();
        break;
      }
    } catch (e) {
      lastError = e;
      const msg = e.message || '';
      console.error(`❌ ${modelName}:`, msg.slice(0,300));
      if (msg.includes('API_KEY') || msg.toLowerCase().includes('api key is invalid')) break;
      continue;
    }
  }

  // Fallback chain if Gemini failed
  if (!generatedReply) {
    const fallbacks = [
      { key: config.groqApiKey, base: 'https://api.groq.com/openai/v1', model: config.groqModel, name: 'Groq' },
      { key: config.cerebrasApiKey, base: 'https://api.cerebras.ai/v1', model: config.cerebrasModel, name: 'Cerebras' },
      { key: config.githubToken, base: 'https://models.github.ai/inference', model: config.githubModel, name: 'GitHub-Models' },
      { key: config.openrouterApiKey, base: 'https://openrouter.ai/api/v1', model: config.openrouterModel, name: 'OpenRouter' },
    ];
    
    for (const fb of fallbacks) {
      if (!fb.key || generatedReply) continue;
      try {
        const r = await callOpenAICompatible({ 
          apiKey: fb.key, 
          baseUrl: fb.base, 
          model: fb.model, 
          messages: buildMessages(userMessage, history, ownerStyleSamples, dynamicSystemPrompt, imagePartForOpenAI), 
          providerName: fb.name,
          extraHeaders: fb.name === 'OpenRouter' ? { 'HTTP-Referer': 'https://github.com', 'X-Title': 'WhatsApp Assistant' } : {}
        });
        generatedReply = r;
        break;
      } catch (e) {
        console.error(`❌ ${fb.name}:`, e.message.slice(0,250));
        lastError = e;
      }
    }
  }

  if (!generatedReply) {
    console.error('💥 All AI failed:', lastError?.message?.slice(0,300));
    return `Hello! I'm ${config.assistantName}, ${config.ownerName}'s assistant. Give me a moment and I'll get back to you shortly 🙂`;
  }

  // ===== POST-GENERATION HARD FILTERS =====
  
  // 1. Check if generated reply contains financial language -> BLOCK
  if (containsFinancialLanguage(generatedReply)) {
    console.log(`🚫 BLOCKED AI reply with financial language from ${jid}: "${generatedReply.slice(0,100)}" -> Handoff`);
    return `__HANDOFF__${getHandoffResponse()} __REASON__: AI generated financial language blocked`;
  }
  
  // 2. Check if generated reply contains romantic/flirty language -> SANITIZE or BLOCK
  if (containsRomanticLanguage(generatedReply)) {
    console.log(`🚫 Romantic language detected in AI reply from ${jid}: "${generatedReply.slice(0,100)}" -> Sanitizing`);
    const sanitized = sanitizeRomanticLanguage(generatedReply);
    // If still contains romantic after sanitization, or is heavily romantic, block
    if (containsRomanticLanguage(sanitized)) {
      console.log(`🚫 Still romantic after sanitize, blocking -> safe fallback`);
      return `Hello! How can I help you today? 🙂`;
    }
    generatedReply = sanitized;
  }
  
  // 3. Check if reply itself is trying to claim to be the owner -> ensure transparency
  const lowerReply = generatedReply.toLowerCase();
  const ownerLower = (config.ownerName || '').toLowerCase();
  if (ownerLower && (lowerReply.includes(`i am ${ownerLower}`) || lowerReply.includes(`i'm ${ownerLower}`)) && !lowerReply.includes('assistant')) {
    console.log(`⚠️ AI claimed to be ${config.ownerName} -> rewriting as assistant`);
    generatedReply = generatedReply.replace(new RegExp(`i(?:'| a)m ${ownerLower}`, 'ig'), `I'm ${config.assistantName}, ${config.ownerName}'s assistant`);
  }
  
  // 4. Final safety: ensure reply is casual small talk, not too personal
  if (generatedReply.length > 700) {
    generatedReply = generatedReply.slice(0, 650) + '...';
  }

  console.log(`✅ Final filtered reply for ${jid}: "${generatedReply.slice(0,100)}..."`);
  return generatedReply;
}

export function isHandoffRequest(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const o = (config.ownerName || '').toLowerCase();
  const triggers = ['real person', 'talk to person', 'stop bot', 'pause bot', '#human', '#stop', '#pause', 'talk to human', 'human please', 'i want human', 'need human', 'person please', 'speak to a human', 'speak to human', 'need a human', 'want a human', 'talk to a human', 'a real person'];
  if (o) triggers.push(`talk to ${o}`, `need ${o}`, `want ${o}`, `speak to ${o}`);
  return triggers.some(t => lower.includes(t));
}

export function parseOwnerCommand(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  if (lower.startsWith('/pause ') || lower.startsWith('/stop ')) {
    const target = text.split(' ')[1]?.replace(/[^0-9]/g, '');
    return { action: 'pause', target };
  }
  if (lower.startsWith('/resume ')) {
    const target = lower.split(' ')[1];
    if (target === 'all') return { action: 'resumeAll' };
    return { action: 'resume', target: target.replace(/[^0-9]/g, '') };
  }
  if (lower.startsWith('/clear ')) {
    const target = lower.split(' ')[1];
    if (target === 'all') return { action: 'clearAll' };
    if (target === 'sessions' || target === 'session') return { action: 'clearSessions' };
    return { action: 'clear', target: target.replace(/[^0-9]/g, '') };
  }
  if (lower === '/clear-sessions' || lower === '/clearsessions' || lower === '/fix-bad-mac') {
    return { action: 'clearSessions' };
  }
  if (lower.startsWith('/style ')) {
    const target = text.split(' ')[1]?.replace(/[^0-9]/g, '');
    return { action: 'style', target };
  }
  if (lower.startsWith('/send ') || lower.startsWith('/sent ')) {
    const rest = text.slice(text.toLowerCase().indexOf(' ', 1)).trim();
    if (!rest) return { action: 'send', target: '', message: '' };
    const tokens = rest.split(/\s+/);
    let splitIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (/[a-zA-Z]{2,}/.test(tokens[i]) && !/^[0-9]+$/.test(tokens[i])) {
        splitIdx = i;
        break;
      }
    }
    let target, message;
    if (splitIdx > 0) {
      target = tokens.slice(0, splitIdx).join(' ');
      message = tokens.slice(splitIdx).join(' ');
    } else {
      target = tokens[0] || '';
      message = tokens.slice(1).join(' ');
    }
    if (message.includes('|') || target.includes('|') || rest.includes('|')) {
      return null;
    }
    return { action: 'send', target, message };
  }
  if (lower === '/status' || lower === '/stats') return { action: 'status' };
  if (lower === '/help') return { action: 'help' };
  if (lower === '/resume all') return { action: 'resumeAll' };
  return null;
}

export function getOwnerHelpText() {
  return `🤖 *${config.assistantName} - ${config.ownerName}'s WhatsApp Assistant*

This assistant answers WhatsApp messages on your behalf, using the identity and goals you set in Render env vars.

✅ *What it does:*
• Greets people, light banter, "how are you"
• Scheduling logistics: "when are you free"
• Tells people you're busy and you'll reply directly for important stuff
• Discloses it's assistant first time to new contact, after handoff, or after 2+ weeks gap - then chats naturally without repeating
• Always re-discloses if asked "are you bot / really you"

🚫 *Hard blocks (never sends):*
• Any financial language: money, accounts, bank, Opay, transfer, etc.
• Romantic/flirty tone or emojis 🥰😍💞😘💋
• Personal/emotional/serious topics -> auto handoff to you

⚠️ *Auto-handoff triggers:*
• Emotional distress, health, family, relationship serious talk
• Financial requests -> flags you
• Important decisions, legal, etc.

🔧 *Quiet-when-you're-active:*
• Bot stays quiet if YOU replied in that chat within last 10m (OWNER_TAKEOVER_PAUSE_MINUTES)
• Uses inactivity window - only replies if you haven't sent message in that chat recently
• No double-replying or competing when you're handling conversation
• Tracks global activity too - if you're active anywhere on WhatsApp, bot stays extra quiet

🎛️ *Manual Controls (self-chat):*
away / back - Toggle global away mode
• "away" = Bot ACTIVE, handles casual while you're away
• "back" = Bot QUIET, won't compete while you're online
/pause 234... - Pause for contact
/resume 234... - Resume
/resume all - Resume all
/clear 234... - Clear history
/clear sessions - Fix Bad MAC
/status - Status + disclosure stats
/help - This help

Disclosure: First time to new contact, after handoff, after 2 weeks gap, or when asked identity. Otherwise natural chat.
`;
}
