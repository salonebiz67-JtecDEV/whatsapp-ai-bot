import { config } from './config.js';
import { getMemoryStore } from './memory.js';
import { generateText } from './ai.js';

// ---------- helpers (all times use YOUR timezone from the TIMEZONE env var) ----------
function tzParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return { dateKey: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10), minute: parseInt(p.minute, 10) };
}

export function todayKey() { return tzParts().dateKey; }

function dateLabel() {
  return new Date().toLocaleDateString('en-GB', { timeZone: config.timezone, weekday: 'short', day: 'numeric', month: 'short' });
}
function hhmm(t) {
  return new Date(t).toLocaleTimeString('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' });
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------- recording (called every time the bot replies) ----------
export async function recordExchange({ jid, name, incoming, reply, handoff = false, reason = '' }) {
  try {
    const mem = await getMemoryStore();
    await mem.addActivity(todayKey(), {
      t: Date.now(), jid, name: name || jid.split('@')[0],
      in: (incoming || '').slice(0, 300), out: (reply || '').slice(0, 300), handoff, reason
    });
  } catch (e) {
    console.warn('recordExchange failed:', e.message);
  }
}

// ---------- building the summary ----------
function needsOwner(entry) {
  if (entry.handoff) return true;
  const owner = escapeRe(config.ownerName || 'owner');
  const out = entry.out || '';
  return new RegExp(`${owner}.{0,45}(know|back|reach|tell|pass|call)|(pass|tell|let|inform|update).{0,35}${owner}`, 'i').test(out);
}

function groupByContact(activity) {
  const map = new Map();
  for (const e of activity) {
    if (!map.has(e.jid)) map.set(e.jid, { jid: e.jid, name: e.name, number: e.jid.split('@')[0], items: [], needsYou: false, reasons: [] });
    const g = map.get(e.jid);
    g.name = e.name || g.name;
    g.items.push(e);
    if (needsOwner(e)) { g.needsYou = true; if (e.reason) g.reasons.push(e.reason); }
  }
  return [...map.values()].sort((a, b) => (b.needsYou - a.needsYou) || (b.items.length - a.items.length));
}

function fallbackText(groups, total) {
  const lines = [`📋 *Daily summary – ${dateLabel()}*`, '', `${config.assistantName} handled ${groups.length} chat${groups.length === 1 ? '' : 's'} (${total} message${total === 1 ? '' : 's'}) today.`];
  const need = groups.filter(g => g.needsYou);
  const rest = groups.filter(g => !g.needsYou);
  if (need.length) {
    lines.push('', '⚠️ *Needs you*');
    for (const g of need) {
      const last = g.items[g.items.length - 1];
      lines.push(`• ${g.name} (+${g.number}): "${(last.in || '').slice(0, 90)}"${g.reasons.length ? ` — ${g.reasons[0]}` : ''}`);
    }
  }
  if (rest.length) {
    lines.push('', '💬 *Other chats*');
    for (const g of rest) {
      const last = g.items[g.items.length - 1];
      lines.push(`• ${g.name}: ${g.items.length} msg${g.items.length === 1 ? '' : 's'}, last: "${(last.in || '').slice(0, 70)}"`);
    }
  }
  return lines.join('\n');
}

export async function buildSummary(dateKey = todayKey()) {
  const mem = await getMemoryStore();
  const activity = await mem.getActivity(dateKey);
  if (!activity.length) {
    return { text: `📋 *Daily summary – ${dateLabel()}*\n\nQuiet day: nobody messaged ${config.assistantName} today. ✅`, chats: 0, messages: 0, usedAI: false };
  }
  const groups = groupByContact(activity);
  const total = activity.length;
  const fallback = fallbackText(groups, total);

  // Ask the AI to write a smarter version, using ONLY the data we give it. Falls back to the plain version if AI fails.
  const data = groups.slice(0, 25).map(g => ({
    name: g.name, number: `+${g.number}`, messages: g.items.length, needs_owner: g.needsYou,
    first: hhmm(g.items[0].t), last: hhmm(g.items[g.items.length - 1].t),
    chat: g.items.slice(-6).map(i => ({ they_said: (i.in || '').slice(0, 160), assistant_replied: (i.out || '').slice(0, 160) }))
  }));
  const prompt = `Write a short WhatsApp summary of today's chats that ${config.assistantName} (AI assistant) handled for ${config.ownerName}.

RULES:
- First line exactly: 📋 *Daily summary – ${dateLabel()}*
- Second line: how many chats and messages (${groups.length} chats, ${total} messages).
- Section "⚠️ *Needs you*": contacts where needs_owner is true, or who asked something the assistant could not answer. One bullet each: name (number) and what they want, in plain words. Skip the section if nobody needs ${config.ownerName}.
- Section "💬 *Other chats*": one short bullet per remaining contact saying what the chat was about (e.g. "greeted, just checking in").
- Use WhatsApp formatting only (*bold*). No markdown headers. Max 20 lines. Keep it warm and brief.
- Use ONLY the data below. Never invent names, numbers, times or facts.

DATA (JSON):
${JSON.stringify(data)}`;

  const ai = await generateText(prompt);
  if (ai && ai.includes('Daily summary')) return { text: ai, chats: groups.length, messages: total, usedAI: true };
  return { text: fallback, chats: groups.length, messages: total, usedAI: false };
}

export async function sendSummary(sock, { dateKey = todayKey(), markSent = false } = {}) {
  const ownerNum = (config.ownerNumber || config.phoneNumber || '').replace(/[^0-9]/g, '');
  if (!ownerNum) throw new Error('PHONE_NUMBER (or OWNER_NUMBER) is not set');
  const result = await buildSummary(dateKey);
  await sock.sendMessage(`${ownerNum}@s.whatsapp.net`, { text: result.text });
  if (markSent) { const mem = await getMemoryStore(); await mem.markSummarySent(dateKey); }
  console.log(`📋 Daily summary sent (${result.chats} chats, ${result.messages} msgs, ${result.usedAI ? 'AI-written' : 'plain'})`);
  return result;
}

// ---------- nightly scheduler: checks every minute, sends once per day after SUMMARY_HOUR ----------
let schedTimer = null;
let running = false;
export function startSummaryScheduler(getSock) {
  if (!config.summaryEnabled || schedTimer) return;
  console.log(`📋 Daily summary ON: sent every night after ${String(config.summaryHour).padStart(2, '0')}:00 (${config.timezone})`);
  schedTimer = setInterval(async () => {
    if (running) return;
    try {
      const sock = getSock();
      if (!sock || global.botStatus !== 'connected') return;
      const { dateKey, hour } = tzParts();
      if (hour < config.summaryHour) return;
      const mem = await getMemoryStore();
      if (await mem.isSummarySent(dateKey)) return;
      running = true;
      await sendSummary(sock, { dateKey, markSent: true });
    } catch (e) {
      console.error('Daily summary failed:', e.message);
    } finally {
      running = false;
    }
  }, 60 * 1000);
}

export async function summaryInfo() {
  const mem = await getMemoryStore();
  return { enabled: config.summaryEnabled, hour: config.summaryHour, timezone: config.timezone, sentToday: await mem.isSummarySent(todayKey()) };
}
