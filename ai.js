import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import { getMemoryStore } from './memory.js';

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
  const dynamicPrompt = systemPrompt;
  
  const msgs = [
    { role: 'system', content: dynamicPrompt },
    ...history.slice(-10).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content.slice(0, 800) })),
  ];
  if (imagePart) msgs.push({ role: 'user', content: [{ type: 'text', text: userMessage }, imagePart] });
  else msgs.push({ role: 'user', content: userMessage });
  return msgs;
}

// Relationship choices shown in the dashboard. tone = how to talk to that kind of person.
export const RELATIONSHIP_OPTIONS = [
  { id: 'friend', label: 'Friend', tone: 'relaxed, friendly and casual' },
  { id: 'best_friend', label: 'Best friend', tone: 'very relaxed, warm and playful; light banter is fine' },
  { id: 'close_friend', label: 'Close friend', tone: 'warm, relaxed and personal in tone' },
  { id: 'family', label: 'Family', tone: 'warm and respectful. Anything emotional, health or money related is an "owner" case' },
  { id: 'mom', label: 'Mom', tone: 'very warm, caring and respectful, no slang. Anything emotional, health or money related is an "owner" case' },
  { id: 'dad', label: 'Dad', tone: 'respectful and warm, no slang. Anything emotional, health or money related is an "owner" case' },
  { id: 'brother', label: 'Brother', tone: 'casual, warm and brotherly' },
  { id: 'sister', label: 'Sister', tone: 'casual, warm and sisterly' },
  { id: 'relative', label: 'Relative', tone: 'respectful and warm. Anything emotional, health or money related is an "owner" case' },
  { id: 'colleague', label: 'Colleague', tone: 'polite, friendly and professional' },
  { id: 'boss', label: 'Boss', tone: 'respectful, polite and professional' },
  { id: 'customer', label: 'Customer', tone: 'polite, helpful and professional' },
  { id: 'other', label: 'Other', tone: 'natural and polite' },
];

// The model answers in JSON: {"mode":"chat|identity|owner","reply":"...","owner_note":"..."}.
// The MODEL decides what the person means. There are no keyword lists anywhere in this file.
function parseModelReply(raw) {
  if (!raw) return null;
  const t = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const tryParse = (s) => { try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch { return null; } };
  let o = tryParse(t);
  if (!o) { const x = t.indexOf('{'), y = t.lastIndexOf('}'); if (x >= 0 && y > x) o = tryParse(t.slice(x, y + 1)); }
  if (o) {
    let parts = [];
    if (Array.isArray(o.reply)) parts = o.reply.map(x => String(x || '').trim()).filter(Boolean);
    else if (typeof o.reply === 'string' && o.reply.trim()) parts = [o.reply.trim()];
    let react = typeof o.react === 'string' ? o.react.trim() : '';
    if (react) {
      try { react = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(react)][0].segment; } catch {}
      if (!/^\p{Extended_Pictographic}/u.test(react) || react.length > 10) react = '';
    }
    if (parts.length || react) {
      const q = Number.parseInt(o.quote, 10);
      return { mode: ['chat', 'identity', 'owner'].includes(o.mode) ? o.mode : 'chat', parts, react, quote: Number.isInteger(q) && q > 0 ? q : 0, note: typeof o.owner_note === 'string' ? o.owner_note.trim() : '' };
    }
  }
  if (!t.startsWith('{')) return { mode: 'chat', parts: [t], react: '', note: '' };
  return null;
}

export function getNigerianTimeContext() {
  try {
    const now = new Date();
    const options = { timeZone: config.timezone, hour12: true, hour: 'numeric', minute: '2-digit', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const full = now.toLocaleString('en-NG', options);
    const hour24 = parseInt(now.toLocaleString('en-US', { timeZone: config.timezone, hour: 'numeric', hour12: false }));
    const hour12 = now.toLocaleString('en-US', { timeZone: config.timezone, hour: 'numeric', hour12: true });
    const minute = now.toLocaleString('en-US', { timeZone: config.timezone, minute: '2-digit' });
    const h12 = hour12.replace(/\s?[AP]M/i, '');
    
    let period = '';
    let greeting = '';
    let greetingInstruction = '';
    
    if (hour24 >= 0 && hour24 < 5) {
      period = 'late night / early morning (12am - 4:59am)';
      greeting = 'Hello';
      greetingInstruction = `It's ${h12}:${minute} AM - very late night/early morning. Use neutral "Hello" not time-specific greeting.`;
    } else if (hour24 >= 5 && hour24 < 12) {
      period = 'morning (5am - 11:59am)';
      greeting = 'Good morning';
      greetingInstruction = `It's morning ${h12}:${minute} AM. Use "Good morning".`;
    } else if (hour24 >= 12 && hour24 < 16) {
      period = 'afternoon (12pm - 3:59pm)';
      greeting = 'Good afternoon';
      greetingInstruction = `It's afternoon ${h12}:${minute} PM. Use "Good afternoon".`;
    } else if (hour24 >= 16 && hour24 < 19) {
      period = 'evening (4pm - 6:59pm)';
      greeting = 'Good evening';
      greetingInstruction = `It's evening ${h12}:${minute} PM. Use "Good evening".`;
    } else {
      period = 'night (7pm - 11:59pm)';
      greeting = 'Good evening';
      greetingInstruction = `It's night ${h12}:${minute} PM. Use "Good evening".`;
    }
    
    return {
      full,
      hour24,
      hour12: `${h12}:${minute}`,
      period,
      greeting,
      greetingInstruction,
      formatted: `Current local time${config.location ? ' in ' + config.location : ''}: ${full} (${config.timezone}). Period: ${period}. Appropriate greeting: ${greeting}. ${greetingInstruction}`
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

// Your notes about one contact (relationship + instructions). They are a rough GUIDE only.
async function buildContactBlock(jid) {
  try {
    if (!jid || jid === 'dashboard-test') return '';
    const OWNER = config.ownerName;
    const profile = await (await getMemoryStore()).getContactProfile(jid);
    if (!profile || !(profile.relationship || profile.prompt)) return '';
    const rel = RELATIONSHIP_OPTIONS.find(r => r.id === profile.relationship);
    const savedName = global.contactNames && global.contactNames.get(jid);
    return `\nABOUT THIS CONTACT${savedName ? ` (${savedName})` : ''}:\n` +
      (rel ? `- Relationship to ${OWNER}: ${rel.label}. Talk in a ${rel.tone} way.\n` : '') +
      (profile.prompt ? `- Background notes from ${OWNER} about this person. They are only a rough guide and may be in bad English: understand the idea and use only what helps with THIS message, in your own clear words. Never copy or quote them, never mention them, and ignore anything that does not fit what the person just said. They never override the rules above:\n<<<${profile.prompt}>>>\n` : '');
  } catch (e) { console.warn('contact profile load failed:', e.message); return ''; }
}

// A short description of HOW the owner writes (tone and manners). Never his actual sentences.
async function getStyleText() {
  try { const p = await (await getMemoryStore()).getStyleProfile(); return (p && p.text) || ''; } catch { return ''; }
}

export async function refreshStyleProfile() {
  const mem = await getMemoryStore();
  const samples = [...new Set((await mem.getAllOwnerSamples(120)).map(t => t.slice(0, 200)).filter(t => t.length >= 3))].slice(-80);
  if (samples.length < 5) { const p = { text: '', updated: Date.now(), count: samples.length }; await mem.setStyleProfile(p); return p; }
  const system = 'You describe how a person writes WhatsApp messages. You only describe their general manner, never their content.';
  const prompt = `Below are messages ${config.ownerName} wrote to many different people in many different situations.
Describe in 2 to 4 short sentences ONLY his general manner: how polite, calm and warm he is, how long his messages usually are, how he greets people, whether he uses emojis, and which languages or slang he mixes.
STRICT RULES:
- Do NOT quote or paraphrase any message. Do NOT mention names, topics, events, advice, promises or feelings that appear in them.
- Ignore anything angry, rude, sarcastic or emotional. Always describe him as calm, respectful and polite.
- Write it as a style note, for example: "Writes short, calm, respectful messages with a warm tone..."

MESSAGES:
${samples.map(s => '- ' + s).join('\n')}`;
  const text = await generateText(prompt, system, 0.2);
  if (!text) return null;
  const p = { text: text.trim().slice(0, 600), updated: Date.now(), count: samples.length };
  await mem.setStyleProfile(p);
  console.log(`🎨 Learned how ${config.ownerName} writes (manner only, from ${samples.length} messages): ${p.text.slice(0, 120)}`);
  return p;
}

// Writes ONE scheduled message (for the daily messages feature) from the owner's rough instruction.
export async function generateScheduledMessage(jid, instruction, history = [], previous = []) {
  const OWNER = config.ownerName;
  const contactBlock = await buildContactBlock(jid);
  const styleText = await getStyleText();
  const t = getNigerianTimeContext();
  const system = `You write ONE WhatsApp message that ${OWNER} scheduled to send to a contact. It is sent from ${OWNER}'s own phone, so write it the way ${OWNER} would: natural, warm, calm and respectful.

PERSONALITY: ${config.persona}
LANGUAGE STYLE: ${config.languageStyle}
${styleText ? `How ${OWNER} usually writes (manner only; never reuse his actual words): ${styleText}\n` : ''}${contactBlock}
RULES:
- Follow ${OWNER}'s instruction below. It may be rough or in bad English: understand what he means and say it clearly in your own natural words. Do not copy the instruction word for word.
- Keep it short (1-3 short lines). Make the wording different from the earlier messages listed below so it never feels copy-pasted.
- Never be romantic, angry, sarcastic or pushy. No money talk and no promises.
- Do not say you are an AI or an assistant, and do not mention that the message is scheduled.
- Any greeting must fit the time of day: it is ${t.period} (${t.greeting}).
Return ONLY the message text, nothing else.`;
  const chat = (history || []).map(h => `${h.role === 'user' ? 'They' : 'Me'}: ${String(h.content || '').slice(0, 160)}`).join('\n') || '(no earlier chat)';
  const prev = (previous || []).map(p => '- ' + p.slice(0, 160)).join('\n') || '(none yet)';
  const prompt = `Instruction from ${OWNER}: ${instruction}\n\nRecent chat with this person (oldest first):\n${chat}\n\nMessages already sent for this schedule on earlier days:\n${prev}\n\nWrite today's message now.`;
  const out = await generateText(prompt, system, 0.9);
  return out ? out.replace(/^["“”]+|["“”]+$/g, '').trim() : null;
}

export async function generateReply(jid, userMessage, history = [], ownerStyleSamples = null, mediaInfo = null, options = {}) {
  const isInternalAgentPrompt = !!(userMessage && (userMessage.includes('Goal for this contact:') || userMessage.includes('STRICT RULES:') || userMessage.includes('AGENT OUTREACH:')));
  const isNewContact = !ownerStyleSamples || ownerStyleSamples.length === 0;
  const timeContext = getNigerianTimeContext();
  const OWNER = config.ownerName;
  const BOT = config.assistantName;
  const st = global.settings || {};
  const chatMode = !!options.meta;                      // normal WhatsApp chat (not a dashboard test or an agent task)
  const canReact = chatMode && st.emojiReactions !== false;
  const canSplit = chatMode && st.splitReplies !== false;
  const stickerReact = chatMode && st.reactToStickers !== false;
  const quoteChoices = (chatMode && st.quoteReplies === 'smart' && Array.isArray(options.quoteChoices)) ? options.quoteChoices : [];
  const canQuote = quoteChoices.length >= 2;
  const quoteText = canQuote ? `QUOTING (WhatsApp swipe-reply): WhatsApp lets you reply to one specific message so the person can see which message you mean. These are the recent messages from this person that you can quote:
${quoteChoices.map(c => `[${c.n}] "${String(c.text).replace(/"/g, "'")}" (${c.ago})`).join('\n')}
Set "quote" to the number of the message you are answering ONLY when it really helps: they sent several messages in a row and you are answering a particular one, or they ask about something they said earlier and newer messages came after it. For a normal back-and-forth answer to their latest message, set "quote" to 0. Most replies need no quote.\n` : '';

  // Facts for the "is this a new conversation?" decision (the AI decides, we only give it the facts)
  const lastTs = [...(history || [])].reverse().map(h => h && h.timestamp).find(Boolean);
  const gapText = (() => {
    if (!(history || []).length) return 'This is the very first message from this person: there is no earlier chat.';
    if (!lastTs) return 'This chat already has earlier messages.';
    const mins = Math.max(0, Math.round((Date.now() - lastTs) / 60000));
    const ago = mins < 2 ? 'a moment' : mins < 60 ? `${mins} minutes` : mins < 1440 ? `${Math.round(mins / 60)} hours` : `${Math.round(mins / 1440)} days`;
    return `The previous message in this chat was ${ago} ago.`;
  })();

  const contactBlock = isInternalAgentPrompt ? '' : await buildContactBlock(jid);
  const styleText = await getStyleText();
  const outreach = options.isAgentTask
    ? `\nThis conversation is an outreach you are doing for ${OWNER}: in your first message briefly say you are ${BOT}, ${OWNER}'s assistant, then follow the goal in the message.\n`
    : '';

  let dynamicSystemPrompt = `
You are ${BOT}, ${OWNER}'s personal assistant. You answer ${OWNER}'s WhatsApp messages for him while he is busy. You are an AI.

PERSONALITY:
${config.persona}

LANGUAGE STYLE:
${config.languageStyle}${st.languages ? `\nLanguages you can use: ${st.languages}.` : ''}${st.writingStyle ? `\nWRITING STYLE chosen by ${OWNER}: ${st.writingStyle}` : ''}

YOUR GOALS:
${config.goals}
${st.aboutOwner ? `\nFACTS ABOUT ${OWNER} (you may use these when someone asks about him; if something is not covered here, it is an "owner" case and you must never guess):\n${st.aboutOwner}\n` : ''}${config.customRules ? `\nEXTRA RULES:\n${config.customRules}\n` : ''}
HOW TO REPLY:
First read the whole conversation so far, then work out what this person means RIGHT NOW. Short replies like "yes", "why?" or "that one" refer to earlier messages. Remember what they already told you, never ask something they already answered, and never repeat yourself.
Then choose exactly ONE mode:
- "chat": normal conversation you can handle yourself (greetings, small talk, jokes, general questions, reacting to stickers or voice notes, anything you can simply answer). Chat like a natural, friendly person. In this mode do NOT say you are an AI or an assistant, do NOT introduce yourself, and do NOT say ${OWNER} is away, busy or not with his phone.
- "identity": the person is asking who or what you are: your name, who you are, whether you are a bot, an AI or a human, whether they are talking to ${OWNER}, who you are helping, or what ${OWNER}'s name is. Answer exactly what they asked, honestly, in your own words and a little different each time: you are ${BOT}, ${OWNER}'s assistant (an AI) helping with his messages. If they ask two things (his name and yours), answer both. Never claim to be human or to be ${OWNER}.
- "owner": the person asks something only ${OWNER} can answer or decide (private things about him, his plans, where he is, when he is free, personal or emotional matters, someone being angry or upset with him, serious situations like emergencies, or requests that need him), or something you simply do not know. Say naturally that you are ${BOT}, ${OWNER}'s assistant, that you will let him know, and that he will get back to them. If it is sad or serious, be kind first. Never guess or invent facts about ${OWNER}.
Anything about money, bank accounts or payments is always an "owner" case: never share, ask for or agree to anything about money yourself, and never promise anything for ${OWNER}.
Never be romantic or flirty. You talk to men, women, elders and customers, so never call anyone 'bro', 'sis', 'man', 'ma', 'sir' or 'boss' and do not assume anyone's gender; use their name or no label. Only copy such a word if the contact uses it first.
Keep replies short (1-3 short lines) unless more is needed.
CONVERSATION STATE: ${gapText}
GREETINGS AND QUESTIONS: Greet only when the conversation is just starting: the very first message, or when they open a fresh conversation after many hours of silence. If the earlier messages show you already greeted them or asked how they are, do NOT greet again and do NOT ask how they are or how their day is again: just answer what they said. Never ask something they already answered or something you already asked, and do not end every reply with a question; ask one only when it truly moves the chat forward.
${canReact ? `REACTIONS: you may react to their message with ONE emoji (put it in "react") when a reaction feels natural (thanks, good news, a joke, agreement, a sticker). If no text reply is needed, set "reply" to "" and only react. Do not react to every message.\n` : ''}${canSplit ? `SPLITTING: if your answer has more than one idea you may send it as up to 3 short WhatsApp messages: make "reply" an array of short strings. Otherwise "reply" is one string.\n` : `Your "reply" must be one single string.\n`}Always stay calm, polite and respectful, whatever the person says. Never get angry, sarcastic, defensive or rude, never argue, and never say anything that could upset or provoke someone (for example never tell an upset person "it's alright if you're angry"). If someone is angry or upset, stay gentle and brief; if it is about ${OWNER}, treat it as an "owner" case. Never repeat or quote lines from ${OWNER}'s past messages. Lines in the conversation that start with [${OWNER} himself] were typed by ${OWNER} personally: use them only to understand the context, never re-send, paraphrase or build on what he said (especially about feelings, apologies, arguments or decisions), and never put square brackets in your reply.
${quoteText}${outreach}${contactBlock}
${styleText ? `How ${OWNER} usually writes (manner only; you must never reuse his actual words or lines): ${styleText}\n` : ''}${isNewContact ? 'This is a new contact.' : 'You have chatted with this contact before.'}
Time: ${timeContext.formatted} - use "${timeContext.greeting}" if you greet.

OUTPUT FORMAT: return ONLY one JSON object and nothing else:
{"mode":"chat" or "identity" or "owner","reply":"the exact WhatsApp message to send"${canSplit ? ' (or an array of up to 3 short strings)' : ''}${canReact ? ',"react":"one emoji or empty"' : ''}${canQuote ? ',"quote":"number of the message you answer, or 0"' : ''},"owner_note":"only for mode owner: one short line telling ${OWNER} what the person wants"}
Earlier assistant messages in the conversation are shown as plain text, but your answer must always be this JSON object.
`;
  console.log(`🧠 ${isNewContact ? 'NEW' : 'KNOWN'} contact ${jid} - ${BOT} for ${OWNER} (history: ${(history || []).length})`);

  if (mediaInfo) {
    if (mediaInfo.type === 'image') {
      dynamicSystemPrompt += `\nUSER SENT IMAGE${mediaInfo.caption ? ` caption: "${mediaInfo.caption}"` : ''}. React casually and lightly as assistant.`;
      if (!userMessage || userMessage === '[Image]' || userMessage.startsWith('[Image')) userMessage = mediaInfo.caption || "Thanks for sharing this image 🙂";
    } else if (mediaInfo.type === 'sticker') {
      dynamicSystemPrompt += stickerReact ? `\nUSER SENT A STICKER${mediaInfo.base64 ? ' (the sticker image is attached)' : ''}. Understand its mood and react with ONE fitting emoji in "react". Leave "reply" empty unless the conversation clearly needs a text answer.` : `\nUSER SENT STICKER. React lightly with humor, friendly, no flirty tone.`;
      if (!userMessage || userMessage === '[Sticker]' || userMessage.startsWith('[sticker')) userMessage = stickerReact ? '(they sent a sticker)' : "Nice sticker 😊";
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
      // Gemini needs the history to start with the contact's turn. If YOU wrote first, keep your lines as context instead of dropping them.
      const leading = [];
      while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') leading.push(geminiHistory.shift().parts[0].text);
      if (leading.length) geminiHistory.unshift({ role: 'user', parts: [{ text: `(Earlier in this chat, already said from our side: ${leading.join(' / ').slice(0, 900)})` }] });
      const cleaned = [];
      for (let i = 0; i < geminiHistory.length; i++) {
        const curr = geminiHistory[i];
        if (cleaned.length > 0 && cleaned[cleaned.length-1].role === curr.role) cleaned[cleaned.length-1].parts[0].text += '\n' + curr.parts[0].text;
        else cleaned.push(curr);
      }
      geminiHistory = cleaned;
      if (imagePartForGemini && (mediaInfo?.type === 'image' || (mediaInfo?.type === 'sticker' && stickerReact))) {
        console.log(`🧠 Asking ${modelName} with IMAGE for ${jid} (${isNewContact ? 'NEW' : 'KNOWN'})`);
        const result = await _send(m.generateContent({ contents: [...geminiHistory.map(h => ({ role: h.role, parts: h.parts })), { role: 'user', parts: [{ text: userMessage }, imagePartForGemini] }], generationConfig: { maxOutputTokens: 1024, temperature: 0.6, topP: 0.9, responseMimeType: 'application/json' } }));
        const text = result.response.text();
        if (!text) throw new Error('Empty');
        generatedReply = text.trim();
        break;
      } else {
        const chat = m.startChat({ history: geminiHistory, generationConfig: { maxOutputTokens: 1024, temperature: 0.6, topP: 0.9, responseMimeType: 'application/json' } });
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
    return `Give me a moment and I'll get back to you shortly 🙂`;
  }

  // ===== READ THE MODEL'S DECISION =====
  const parsed = parseModelReply(generatedReply);
  const noText = !parsed || (!parsed.parts.length && !(canReact && parsed.react));
  if (noText) {
    console.error('⚠️ Could not read AI answer, sending safe fallback:', String(generatedReply).slice(0, 120));
    return `Give me a moment and I'll get back to you shortly 🙂`;
  }
  console.log(`🎯 Mode chosen by AI for ${jid}: ${parsed.mode}${parsed.react ? ' + reaction ' + parsed.react : ''}`);
  if (parsed.mode === 'owner' && options.meta) { options.meta.needsOwner = true; options.meta.note = parsed.note || ''; }

  let parts = parsed.parts.map(p => (p.length > 700 ? p.slice(0, 650) + '...' : p));
  if (!canSplit && parts.length > 1) parts = [parts.join('\n')];
  parts = parts.slice(0, 3);

  // One safety net that is NOT about words: never send out a long number (like a bank account number).
  if (parts.some(p => /\d{9,}/.test(p.replace(/[\s-]/g, '')))) {
    console.log(`🛡️ Reply contained a long number, replaced with a safe answer for ${jid}`);
    parts = [`Let me check with ${OWNER} and get back to you on that.`];
    if (options.meta) { options.meta.needsOwner = true; options.meta.note = options.meta.note || 'A long number came up in the reply'; }
  }

  if (options.meta) { options.meta.parts = parts; options.meta.react = canReact ? parsed.react : ''; options.meta.quote = canQuote && parsed.quote <= quoteChoices.length ? parsed.quote : 0; }
  const reply = parts.join('\n');
  console.log(`✅ Final reply for ${jid}: "${reply.slice(0, 100)}${parsed.react ? '" +' + parsed.react : '"'}`);
  return reply;
}

// Plain text generation (no persona, no chat history). Used for the nightly summary. Returns null if every provider fails.
export async function generateText(prompt, systemPrompt = 'You write short, clear, accurate summaries. Only use facts you are given.', temperature = 0.3) {
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  if (config.geminiApiKey) {
    const models = [...new Set([config.geminiModel, 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest'])];
    for (const name of models) {
      try {
        const m = initGemini(name, systemPrompt);
        const r = await withTimeout(m.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1500, temperature } }), 25000);
        const t = r.response.text();
        if (t && t.trim()) return t.trim();
      } catch (e) { console.warn(`generateText ${name}: ${(e.message || '').slice(0, 120)}`); }
    }
  }
  if (config.groqApiKey) {
    try {
      return await callOpenAICompatible({ apiKey: config.groqApiKey, baseUrl: 'https://api.groq.com/openai/v1', model: config.groqModel, providerName: 'Groq',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }] });
    } catch (e) { console.warn('generateText Groq: ' + (e.message || '').slice(0, 120)); }
  }
  return null;
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
