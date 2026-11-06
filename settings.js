import { config } from './config.js';
import { getMemoryStore } from './memory.js';

// Everything the owner can change from the dashboard Settings tab. Saved in Upstash (or a local file) and applied instantly.
export const TYPING_MS_PER_CHAR = { fast: 30, normal: 55, slow: 85 };

const BASE = {
  ownerName: config.ownerName, assistantName: config.assistantName, persona: config.persona, goals: config.goals,
  maxPerHour: config.maxPerHour, summaryEnabled: config.summaryEnabled, summaryHour: config.summaryHour
};

export function defaultSettings() {
  return {
    // natural replies & pacing
    humanTyping: true, typingSpeed: 'fast', delayMin: 1, delayMax: 3,
    burstBatching: true, quietSeconds: 5, splitReplies: true,
    emojiReactions: true, reactToStickers: true, quoteReplies: 'smart',
    maxPerHourContact: BASE.maxPerHour, maxPerHourGlobal: 300,
    // about you and the AI
    ownerName: BASE.ownerName, assistantName: BASE.assistantName, aboutOwner: '', languages: 'English, Krio', writingStyle: '',
    persona: BASE.persona, goals: BASE.goals,
    // alerts, learning, schedule
    alerts: true, learnFromReplies: true,
    summaryEnabled: BASE.summaryEnabled, summaryHour: BASE.summaryHour,
    quietHoursEnabled: false, quietFrom: '23:00', quietTo: '06:00'
  };
}

const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const str = (v, max, d = '') => (typeof v === 'string' ? v.trim().slice(0, max) : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const hhmm = (v, d) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);

// Keeps only known settings and forces every value into a safe range
export function sanitize(p = {}, cur = defaultSettings()) {
  const o = {};
  if ('humanTyping' in p) o.humanTyping = bool(p.humanTyping, cur.humanTyping);
  if ('typingSpeed' in p) o.typingSpeed = TYPING_MS_PER_CHAR[p.typingSpeed] ? p.typingSpeed : cur.typingSpeed;
  if ('delayMin' in p) o.delayMin = num(p.delayMin, 0, 60, cur.delayMin);
  if ('delayMax' in p) o.delayMax = num(p.delayMax, 0, 120, cur.delayMax);
  if ('burstBatching' in p) o.burstBatching = bool(p.burstBatching, cur.burstBatching);
  if ('quietSeconds' in p) o.quietSeconds = Math.round(num(p.quietSeconds, 2, 12, cur.quietSeconds));
  if ('splitReplies' in p) o.splitReplies = bool(p.splitReplies, cur.splitReplies);
  if ('emojiReactions' in p) o.emojiReactions = bool(p.emojiReactions, cur.emojiReactions);
  if ('quoteReplies' in p) o.quoteReplies = ['smart', 'always', 'off'].includes(p.quoteReplies) ? p.quoteReplies : cur.quoteReplies;
  if ('reactToStickers' in p) o.reactToStickers = bool(p.reactToStickers, cur.reactToStickers);
  if ('maxPerHourContact' in p) o.maxPerHourContact = Math.round(num(p.maxPerHourContact, 1, 1000, cur.maxPerHourContact));
  if ('maxPerHourGlobal' in p) o.maxPerHourGlobal = Math.round(num(p.maxPerHourGlobal, 1, 5000, cur.maxPerHourGlobal));
  if ('ownerName' in p) o.ownerName = str(p.ownerName, 40) || cur.ownerName;
  if ('assistantName' in p) o.assistantName = str(p.assistantName, 40) || cur.assistantName;
  if ('aboutOwner' in p) o.aboutOwner = str(p.aboutOwner, 1500);
  if ('languages' in p) o.languages = str(p.languages, 120);
  if ('writingStyle' in p) o.writingStyle = str(p.writingStyle, 300);
  if ('persona' in p) o.persona = str(p.persona, 800) || cur.persona;
  if ('goals' in p) o.goals = str(p.goals, 800) || cur.goals;
  if ('alerts' in p) o.alerts = bool(p.alerts, cur.alerts);
  if ('learnFromReplies' in p) o.learnFromReplies = bool(p.learnFromReplies, cur.learnFromReplies);
  if ('summaryEnabled' in p) o.summaryEnabled = bool(p.summaryEnabled, cur.summaryEnabled);
  if ('summaryHour' in p) o.summaryHour = Math.round(num(p.summaryHour, 0, 23, cur.summaryHour));
  if ('quietHoursEnabled' in p) o.quietHoursEnabled = bool(p.quietHoursEnabled, cur.quietHoursEnabled);
  if ('quietFrom' in p) o.quietFrom = hhmm(p.quietFrom, cur.quietFrom);
  if ('quietTo' in p) o.quietTo = hhmm(p.quietTo, cur.quietTo);
  return o;
}

function apply(s) {
  if (s.delayMax < s.delayMin) s.delayMax = s.delayMin;
  config.ownerName = s.ownerName; config.assistantName = s.assistantName;
  config.persona = s.persona; config.goals = s.goals;
  config.maxPerHour = s.maxPerHourContact;
  config.summaryEnabled = s.summaryEnabled; config.summaryHour = s.summaryHour;
  config.fastReplies = !s.humanTyping;
  global.settings = s;
  return s;
}

global.settings = apply(defaultSettings());

export function getSettings() { return global.settings; }

export async function loadSettings() {
  try {
    const mem = await getMemoryStore();
    const saved = await mem.getSettings();
    const base = defaultSettings();
    apply({ ...base, ...sanitize(saved || {}, base) });
    if (saved) console.log('⚙️ Loaded your saved settings from the dashboard');
  } catch (e) { console.warn('loadSettings failed:', e.message); }
  return global.settings;
}

export async function updateSettings(patch) {
  const next = { ...global.settings, ...sanitize(patch, global.settings) };
  apply(next);
  const mem = await getMemoryStore();
  await mem.setSettings(global.settings);
  console.log('⚙️ Settings updated from the dashboard');
  return global.settings;
}
