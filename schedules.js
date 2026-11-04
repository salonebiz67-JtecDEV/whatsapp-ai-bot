import { config } from './config.js';
import { getMemoryStore } from './memory.js';
import { generateScheduledMessage, refreshStyleProfile } from './ai.js';
import { trackChat } from './chats.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const GRACE_MINUTES = parseInt(process.env.SCHEDULE_GRACE_MINUTES || '120', 10); // if the bot was offline, still send up to 2h late, never later
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Current date/time in YOUR timezone (TIMEZONE env var)
export function localNow() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { dateKey: `${p.year}-${p.month}-${p.day}`, minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10), weekday: WEEKDAYS[p.weekday] };
}

export function newScheduleId() {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Writes today's message with the AI from the instruction, sends it, and remembers it
export async function runSchedule(sock, sch, { markSent = true } = {}) {
  const mem = await getMemoryStore();
  const history = await mem.getHistory(sch.jid);
  const text = await generateScheduledMessage(sch.jid, sch.text, (history || []).slice(-8), sch.lastTexts || []);
  if (!text) throw new Error('The AI could not write the message (all AI providers failed)');
  await sock.sendMessage(sch.jid, { text });
  await mem.addMessage(sch.jid, 'assistant', text);
  trackChat(sch.jid, { role: 'bot', text });
  if (markSent) {
    sch.lastSent = localNow().dateKey;
    sch.lastTexts = [...(sch.lastTexts || []), text].slice(-4);
    sch.lastError = '';
    await mem.saveSchedule(sch);
  }
  console.log(`⏰ Scheduled message sent to ${sch.jid.split('@')[0]}: "${text.slice(0, 80)}"`);
  return text;
}

let timer = null;
let running = false;
let tickCount = 0;
export function startSchedulers(getSock) {
  if (timer) return;
  console.log(`⏰ Daily messages ON (times use ${config.timezone})`);
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    tickCount++;
    try {
      const sock = getSock();
      const mem = await getMemoryStore();

      // Learn HOW you write (manner only). Checked about once an hour.
      if (tickCount % 60 === 1) {
        try {
          const p = await mem.getStyleProfile();
          const stale = !p || !p.updated || Date.now() - p.updated > 3 * 24 * 3600 * 1000;
          if (stale) await refreshStyleProfile();
        } catch (e) { console.warn('style refresh skipped:', e.message); }
      }

      if (!sock || global.botStatus !== 'connected' || global.botPaused) return;
      const now = localNow();
      const list = await mem.listSchedules();
      for (const s of list) {
        if (!s.enabled || s.lastSent === now.dateKey) continue;
        if (Array.isArray(s.days) && s.days.length && !s.days.includes(now.weekday)) continue;
        const [h, m] = String(s.time).split(':').map(Number);
        const due = h * 60 + m;
        if (now.minutes < due || now.minutes > due + GRACE_MINUTES) continue;
        if (s.lastAttempt && Date.now() - s.lastAttempt < 10 * 60 * 1000) continue; // don't hammer a failing AI
        try {
          s.lastAttempt = Date.now();
          await runSchedule(sock, s);
        } catch (e) {
          s.lastError = e.message;
          await mem.saveSchedule(s);
          console.error(`⏰ Scheduled message failed for ${s.jid.split('@')[0]}: ${e.message}`);
        }
        await sleep(4000 + Math.floor(Math.random() * 4000));
      }
    } catch (e) {
      console.error('Scheduler error:', e.message);
    } finally {
      running = false;
    }
  }, 60 * 1000);
}
