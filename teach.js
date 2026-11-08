import { getMemoryStore } from './memory.js';
import { AUDIENCES, clearTeachCache, generateText } from './ai.js';
import { config } from './config.js';
import { trackChat } from './chats.js';

// "Teach me": answer cards you wrote + an inbox of questions the AI could not answer.

export const MAX_CARDS = 60;

function normKey(q) {
  return String(q || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 140);
}
function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Called when the AI says "I'll let him know" about a question someone asked.
export async function addToInbox({ question, note, jid, name, relationship }) {
  try {
    const q = String(question || '').trim().slice(0, 200);
    if (!q) return null;
    const mem = await getMemoryStore();
    const key = normKey(q);
    if (!key) return null;
    const items = await mem.listInbox();
    const now = Date.now();
    let item = items.find(i => i.key === key);
    if (!item) item = { id: newId('q_'), key, question: q, note: String(note || '').slice(0, 200), askers: [], count: 0, firstTs: now };
    item.count = (item.count || 0) + 1;
    item.lastTs = now;
    if (!item.askers.some(a => a.jid === jid)) item.askers.push({ jid, name: name || jid.split('@')[0], relationship: relationship || '', ts: now });
    item.askers = item.askers.slice(-6);
    await mem.saveInboxItem(item);
    console.log(`📥 Teach me inbox: "${q}" (asked ${item.count}x)`);
    return item;
  } catch (e) { console.warn('addToInbox failed:', e.message); return null; }
}

export function cleanCard(body, existing = {}) {
  const topic = String(body.topic ?? existing.topic ?? '').trim().slice(0, 120);
  const answer = String(body.answer ?? existing.answer ?? '').trim().slice(0, 400);
  if (!topic) throw new Error('Write the topic or question first');
  if (!answer) throw new Error('Write the answer first');
  const audience = String(body.audience ?? existing.audience ?? 'everyone');
  if (!AUDIENCES.some(a => a.id === audience)) throw new Error('Unknown audience');
  const jid = String(body.jid ?? existing.jid ?? '');
  if (jid && !/^[0-9a-zA-Z@._-]{3,80}$/.test(jid)) throw new Error('Bad chat id');
  return { id: existing.id || newId('c_'), topic, answer, audience, jid, enabled: body.enabled === undefined ? (existing.enabled !== false) : !!body.enabled, source: existing.source || body.source || 'manual', created: existing.created || Date.now(), updated: Date.now() };
}

export async function saveCard(card) {
  const mem = await getMemoryStore();
  const all = await mem.listCards();
  if (!all.some(c => c.id === card.id) && all.length >= MAX_CARDS) throw new Error(`You can keep up to ${MAX_CARDS} cards. Delete one first.`);
  await mem.saveCard(card);
  clearTeachCache();
  return card;
}

// ---------- after you answer a question, tell the people who were waiting ----------
export function askersForCard(item, card) {
  const aud = AUDIENCES.find(a => a.id === card.audience);
  return (item.askers || []).filter(a => {
    if (!a.jid || !a.jid.endsWith('@s.whatsapp.net')) return false;
    if (card.jid) return a.jid === card.jid;
    if (!aud || aud.id === 'everyone') return true;
    return !!(a.relationship && aud.rels && aud.rels.includes(a.relationship));
  }).slice(0, 6);
}

async function composeFollowUp(item, answer, asker) {
  const OWNER = config.ownerName;
  const prompt = `${OWNER}'s assistant is following up with someone who earlier asked a question that could not be answered at that moment. ${OWNER} has now given the answer. Write the WhatsApp message that tells them the answer.

THEIR QUESTION: ${item.question}
THE ANSWER FROM ${OWNER} (rough notes, maybe poor English: understand it and say it in your own clear, natural words): <<<${String(answer).slice(0, 400)}>>>

PERSONALITY: ${config.persona}
LANGUAGE STYLE: ${config.languageStyle}
RULES: 1-3 short lines. Warm, calm and polite. Say it is the answer to what they asked earlier, without greeting them from scratch. Do not add facts that are not in the answer. Nothing about money transfers or bank details. Output ONLY the message text.`;
  const out = await generateText(prompt, 'You write short, natural, respectful WhatsApp messages. Output only the message text.');
  const text = (out || '').trim().replace(/^["“'`]+|["”'`]+$/g, '').trim();
  return text && text.length <= 600 ? text : null;
}

export async function sendFollowUps(sock, item, card, answer) {
  const mem = await getMemoryStore();
  let sent = 0;
  const targets = askersForCard(item, card);
  for (const a of targets) {
    try {
      const text = await composeFollowUp(item, answer, a);
      if (!text) continue;
      await sock.sendPresenceUpdate('composing', a.jid);
      await new Promise(r => setTimeout(r, 1500 + Math.min(text.length * 40, 3000)));
      await sock.sendMessage(a.jid, { text });
      await sock.sendPresenceUpdate('paused', a.jid);
      await mem.addMessage(a.jid, 'assistant', text);
      trackChat(a.jid, { role: 'bot', text });
      sent++;
      console.log(`📤 Sent the new answer to ${a.name || a.jid.split('@')[0]}: "${text.slice(0, 80)}"`);
      if (targets.length > 1) await new Promise(r => setTimeout(r, 6000 + Math.floor(Math.random() * 5000)));
    } catch (e) { console.warn(`follow-up to ${a.jid} failed: ${e.message}`); }
  }
  return { sent, eligible: targets.length };
}
