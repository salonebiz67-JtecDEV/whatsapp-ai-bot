import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import http from 'http';
import { config, validateConfig } from './config.js';
import { createAuthState } from './auth.js';
import { getMemoryStore } from './memory.js';
import { RELATIONSHIP_OPTIONS, generateReply, refreshStyleProfile, parseOwnerCommand, getOwnerHelpText, getNigerianTimeContext } from './ai.js';
import { extractOwnerStyleFromExport } from './import.js';
import fs from 'fs';
import { trackChat } from './chats.js';
import { loadSettings, updateSettings, TYPING_MS_PER_CHAR } from './settings.js';
import { startSchedulers, runSchedule, newScheduleId, localNow } from './schedules.js';
import { recordExchange, startSummaryScheduler, sendSummary, buildSummary, summaryInfo } from './summary.js';
import { getAgentManager, parseAgentCommand, parseNaturalAgentIntent, extractNumbersFromVcard, extractNumbersRobust } from './agent.js';

// Suppress noisy Bad MAC stack traces - keep logs clean, only show summary
const originalConsoleError = console.error;
let badMacCount = 0;
let lastBadMacLog = 0;
console.error = (...args) => {
  const msg = args.join(' ');
  if (msg.includes('Bad MAC') || msg.includes('Failed to decrypt message with any known session')) {
    badMacCount++;
    const now = Date.now();
    // Only log every 10 seconds to avoid spam
    if (now - lastBadMacLog > 10000) {
      console.log(`⚠️ Bad MAC x${badMacCount} - old corrupted sessions (will auto-clear on next restart). These are old queued messages that can't be decrypted, not new messages. New messages will work after session clear.`);
      lastBadMacLog = now;
      badMacCount = 0;
    }
    return;
  }
  if (msg.includes('Session error:Error: Bad MAC')) {
    return; // Suppress stack trace
  }
  if (msg.includes('at Object.verifyMAC') || msg.includes('at SessionCipher.doDecryptWhisperMessage') || msg.includes('at async') && msg.includes('session_cipher.js')) {
    // Suppress stack traces for Bad MAC
    if (msg.includes('Bad MAC') || badMacCount > 0) return;
  }
  originalConsoleError(...args);
};

// ===== Dashboard: in-memory log buffer + counters =====
global.stats = { received: 0, replied: 0, errors: 0, startedAt: Date.now() };
global.botPaused = false;
global.pairing = null;
global.manualConnect = false;
global.contactNames = new Map(); // jid -> saved WhatsApp contact name
global.replyTimes = [];                // timestamps of replies in the last hour (global limit)
loadSettings();                        // dashboard settings (also loaded again when the bot starts)
const LOG_MAX = 400;
const logBuffer = [];
let logSeq = 0;
function safeStr(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}
function pushLog(level, args) {
  try {
    const msg = args.map(safeStr).join(' ').slice(0, 700);
    logBuffer.push({ id: ++logSeq, t: Date.now(), level, msg });
    if (logBuffer.length > LOG_MAX) logBuffer.shift();
    if (level === 'error') global.stats.errors++;
  } catch {}
}
{
  const _log = console.log.bind(console);
  const _warn = console.warn.bind(console);
  const _err = console.error;
  console.log = (...a) => { pushLog('info', a); _log(...a); };
  console.warn = (...a) => { pushLog('warn', a); _warn(...a); };
  console.error = (...a) => {
    const m = a.map(safeStr).join(' ');
    if (!(m.includes('Bad MAC') || m.includes('Failed to decrypt') || m.includes('session_cipher'))) pushLog('error', a);
    _err(...a);
  };
}

let dashboardHtml = '<h2>dashboard.html is missing. Upload it to your GitHub repo next to index.js.</h2>';
try { dashboardHtml = fs.readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8'); } catch (e) { console.warn('dashboard.html not found:', e.message); }

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function isLinked() {
  // NOTE: requesting a pairing code already sets creds.me (with name '~'), so creds.me alone does NOT mean linked.
  // creds.account only exists after WhatsApp confirms the pairing.
  const c = auth && auth.state && auth.state.creds;
  return !!(c && (c.registered || c.account || (c.me && c.me.name && c.me.name !== '~')));
}

// WhatsApp profile pictures (cached on the server so the dashboard loads fast)
const avatarCache = new Map();
async function getAvatar(jid) {
  const c = avatarCache.get(jid);
  if (c && Date.now() - c.ts < (c.none ? 60 * 60 * 1000 : 6 * 60 * 60 * 1000)) return c;
  if (!sock || global.botStatus !== 'connected') return c || null;
  let entry = { none: true, ts: Date.now() };
  try {
    const url = await sock.profilePictureUrl(jid, 'image');   // full size (the 'preview' size looks blurry)
    if (url) {
      const r = await fetch(url);
      if (r.ok) entry = { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/jpeg', ts: Date.now() };
    }
  } catch {}
  if (avatarCache.size > 300) avatarCache.delete(avatarCache.keys().next().value);
  avatarCache.set(jid, entry);
  return entry;
}

async function handleApi(req, res, reqPath) {
  try {
    if (reqPath === '/api/status') {
      const ai = [];
      if (config.geminiApiKey) ai.push('Gemini');
      if (config.groqApiKey) ai.push('Groq');
      if (config.cerebrasApiKey) ai.push('Cerebras');
      if (config.githubToken) ai.push('GitHub');
      if (config.openrouterApiKey) ai.push('OpenRouter');
      return sendJson(res, 200, {
        status: global.botStatus || 'starting',
        connected: global.botStatus === 'connected',
        linked: isLinked(),
        number: sock && sock.user && sock.user.id ? sock.user.id.split(':')[0].split('@')[0] : null,
        uptime: Math.floor(process.uptime()),
        paused: !!global.botPaused,
        stats: global.stats,
        pairing: global.pairing,
        summary: await summaryInfo().catch(() => null),
        phoneNumber: config.phoneNumber,
        settings: {
          ownerName: config.ownerName, assistantName: config.assistantName, location: config.location,
          timezone: config.timezone, fastReplies: config.fastReplies, ai, redis: !!(auth && auth.isRedis),
          maxPerHour: config.maxPerHour
        }
      });
    }
    if (reqPath === '/api/chats') {
      const mem = await getMemoryStore();
      const list = (await mem.listContacts()).slice(0, 60);
      const profiles = await mem.listContactProfiles();
      const chats = list.map(c => ({
        jid: c.jid,
        number: c.jid.endsWith('@s.whatsapp.net') ? c.jid.split('@')[0] : '',
        name: (global.contactNames.get(c.jid)) || c.name || (c.jid.endsWith('@s.whatsapp.net') ? '+' + c.jid.split('@')[0] : 'Unknown contact'),
        last: c.last, role: c.role, ts: c.ts, count: c.count,
        relationship: (profiles[c.jid] && profiles[c.jid].relationship) || '',
        relationshipLabel: ((RELATIONSHIP_OPTIONS.find(r => profiles[c.jid] && r.id === profiles[c.jid].relationship)) || {}).label || '',
        hasNotes: !!(profiles[c.jid] && profiles[c.jid].prompt),
        botOff: !!(profiles[c.jid] && profiles[c.jid].botOff)
      }));
      return sendJson(res, 200, { chats, paused: !!global.botPaused });
    }
    if (reqPath === '/api/chat') {
      const jid = new URL(req.url, 'http://localhost').searchParams.get('jid') || '';
      if (!/^[0-9a-zA-Z@._-]{3,80}$/.test(jid)) return sendJson(res, 400, { error: 'Bad chat id' });
      const mem = await getMemoryStore();
      const contacts = await mem.listContacts();
      const c = contacts.find(x => x.jid === jid) || { jid };
      return sendJson(res, 200, {
        jid,
        number: jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : '',
        name: (global.contactNames.get(jid)) || c.name || (jid.endsWith('@s.whatsapp.net') ? '+' + jid.split('@')[0] : 'Unknown contact'),
        profile: (await mem.getContactProfile(jid)) || { relationship: '', prompt: '' },
        options: RELATIONSHIP_OPTIONS.map(r => ({ id: r.id, label: r.label })),
        schedules: (await mem.listSchedules()).filter(x => x.jid === jid).map(x => ({ id: x.id, text: x.text, time: x.time, days: x.days || [], enabled: !!x.enabled, lastSent: x.lastSent || '', lastError: x.lastError || '' })),
        timezone: config.timezone,
        messages: await mem.getChatLog(jid)
      });
    }
    if (reqPath === '/api/avatar') {
      const jid = new URL(req.url, 'http://localhost').searchParams.get('jid') || '';
      if (!/^[0-9a-zA-Z@._-]{3,80}$/.test(jid)) return sendJson(res, 400, { error: 'Bad chat id' });
      const av = await getAvatar(jid);
      if (!av || av.none || !av.buf) return sendJson(res, 404, { error: 'No profile picture' });
      res.writeHead(200, { 'Content-Type': av.type, 'Cache-Control': 'private, max-age=3600' });
      return res.end(av.buf);
    }
    if (reqPath === '/api/style') {
      const mem = await getMemoryStore();
      const p = await mem.getStyleProfile();
      return sendJson(res, 200, { text: (p && p.text) || '', updated: (p && p.updated) || 0, count: (p && p.count) || 0 });
    }
    if (reqPath === '/api/settings') {
      return sendJson(res, 200, { settings: global.settings });
    }
    if (reqPath === '/api/logs') {
      const since = parseInt(new URL(req.url, 'http://localhost').searchParams.get('since') || '0', 10);
      return sendJson(res, 200, { logs: logBuffer.filter(l => l.id > since) });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
    const body = await readBody(req);

    if (reqPath === '/api/contact') {
      const jid = String(body.jid || '');
      if (!/^[0-9a-zA-Z@._-]{3,80}$/.test(jid)) return sendJson(res, 400, { error: 'Bad chat id' });
      const relationship = String(body.relationship || '');
      if (relationship && !RELATIONSHIP_OPTIONS.some(r => r.id === relationship)) return sendJson(res, 400, { error: 'Unknown relationship' });
      const mem = await getMemoryStore();
      const saved = await mem.setContactProfile(jid, { relationship, prompt: String(body.prompt || ''), botOff: !!body.botOff });
      console.log(`📝 Saved contact settings for ${jid.split('@')[0]} (${relationship || 'no relationship'}${saved.prompt ? ', custom instructions' : ''}, AI ${saved.botOff ? 'OFF' : 'ON'})`);
      return sendJson(res, 200, { ok: true, profile: saved });
    }
    if (reqPath === '/api/style/refresh') {
      const p = await refreshStyleProfile();
      if (!p) return sendJson(res, 500, { error: 'The AI could not write the style note right now. Try again later.' });
      return sendJson(res, 200, { ok: true, text: p.text, updated: p.updated, count: p.count });
    }
    if (reqPath === '/api/schedule') {
      const jid = String(body.jid || '');
      if (!/^[0-9a-zA-Z@._-]{3,80}$/.test(jid)) return sendJson(res, 400, { error: 'Bad chat id' });
      const text = String(body.text || '').trim().slice(0, 600);
      const time = String(body.time || '');
      if (!text) return sendJson(res, 400, { error: 'Tell the AI what to say first.' });
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return sendJson(res, 400, { error: 'Pick a valid time.' });
      const days = Array.isArray(body.days) ? [...new Set(body.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))] : [];
      const mem = await getMemoryStore();
      const existing = body.id ? (await mem.listSchedules()).find(x => x.id === body.id && x.jid === jid) : null;
      const sch = {
        id: existing ? existing.id : newScheduleId(), jid, text, time,
        days: days.length === 7 ? [] : days,
        enabled: body.enabled === undefined ? (existing ? existing.enabled : true) : !!body.enabled,
        lastSent: existing ? existing.lastSent : '', lastTexts: existing ? existing.lastTexts : [], created: existing ? existing.created : Date.now()
      };
      const changed = !existing || existing.time !== time || existing.text !== text || JSON.stringify(existing.days || []) !== JSON.stringify(sch.days);
      if (changed && sch.enabled) { // the first message goes out at the NEXT chosen time, not right now
        const nowL = localNow();
        if (nowL.minutes >= parseInt(time.slice(0, 2), 10) * 60 + parseInt(time.slice(3, 5), 10)) sch.lastSent = nowL.dateKey; else sch.lastSent = '';
      }
      await mem.saveSchedule(sch);
      console.log(`⏰ Daily message ${existing ? 'updated' : 'added'} for ${jid.split('@')[0]} at ${time} (${sch.enabled ? 'ON' : 'OFF'})`);
      return sendJson(res, 200, { ok: true, schedule: { id: sch.id, text: sch.text, time: sch.time, days: sch.days, enabled: sch.enabled, lastSent: sch.lastSent } });
    }
    if (reqPath === '/api/schedule/delete') {
      const mem = await getMemoryStore();
      await mem.deleteSchedule(String(body.id || ''));
      return sendJson(res, 200, { ok: true });
    }
    if (reqPath === '/api/schedule/run') {
      if (global.botStatus !== 'connected' || !sock) return sendJson(res, 400, { error: 'WhatsApp is not connected right now.' });
      const mem = await getMemoryStore();
      const sch = (await mem.listSchedules()).find(x => x.id === String(body.id || ''));
      if (!sch) return sendJson(res, 404, { error: 'Schedule not found' });
      const text = await runSchedule(sock, sch, { markSent: false });
      return sendJson(res, 200, { ok: true, text });
    }
    if (reqPath === '/api/settings/save') {
      const saved = await updateSettings(body && typeof body === 'object' ? body : {});
      return sendJson(res, 200, { ok: true, settings: saved });
    }
    if (reqPath === '/api/pause') {
      await setPaused(!!body.paused);
      return sendJson(res, 200, { ok: true, paused: global.botPaused });
    }
    if (reqPath === '/api/restart') {
      if (sock && global.sockRef) {
        console.log('🔄 Restart requested from dashboard');
        try { sock.end(new Error('Manual restart from dashboard')); } catch {}
        return sendJson(res, 200, { ok: true, message: 'Restarting… it reconnects in about 10 seconds.' });
      }
      global.manualConnect = true;
      startBot();
      return sendJson(res, 200, { ok: true, message: 'Starting connection…' });
    }
    if (reqPath === '/api/logout') {
      console.log('⏏ Logout requested from dashboard');
      try { if (sock && global.sockRef) await sock.logout(); } catch (e) { console.log('logout note: ' + e.message); }
      try { if (auth && auth.clearState) await auth.clearState(); } catch {}
      global.manualConnect = false;
      global.pairing = null;
      global.botStatus = 'not-linked';
      isStarting = false;
      return sendJson(res, 200, { ok: true, message: 'Logged out. Use “Connect WhatsApp” to link again.' });
    }
    if (reqPath === '/api/pair') {
      const number = String(body.number || config.phoneNumber || '').replace(/[^0-9]/g, '');
      if (number.length < 7) return sendJson(res, 400, { error: 'Enter your WhatsApp number with country code, e.g. 23276123456' });
      if (global.botStatus === 'connected') return sendJson(res, 400, { error: 'Already connected. Log out first to link a different number.' });
      if (isLinked()) return sendJson(res, 400, { error: 'This bot is already linked. Tap “Restart connection” instead of asking for a new code.' });
      global.manualConnect = true;
      if (!global.sockRef) {
        startBot();
        for (let i = 0; i < 30 && !global.sockRef; i++) await delay(500);
      }
      if (!global.sockRef) return sendJson(res, 500, { error: 'Could not start the connection. Check the logs below and try again.' });
      await delay(3000);
      try {
        const raw = await sock.requestPairingCode(number);
        const code = (raw || '').match(/.{1,4}/g)?.join('-') || raw;
        global.pairing = { code, number, at: Date.now() };
        console.log(`🔑 Pairing code generated from dashboard for ${number}`);
        return sendJson(res, 200, { ok: true, pairing: global.pairing });
      } catch (e) {
        console.error('Pairing code failed:', e.message);
        return sendJson(res, 500, { error: 'WhatsApp refused the code request: ' + e.message });
      }
    }
    if (reqPath === '/api/summary') {
      if (body.action === 'send') {
        if (global.botStatus !== 'connected' || !sock) return sendJson(res, 400, { error: 'WhatsApp is not connected right now.' });
        const r = await sendSummary(sock, { markSent: false });
        return sendJson(res, 200, { ok: true, text: r.text, message: 'Summary sent to your WhatsApp.' });
      }
      const r = await buildSummary();
      return sendJson(res, 200, { ok: true, text: r.text, usedAI: r.usedAI });
    }
    if (reqPath === '/api/test') {
      const message = String(body.message || '').slice(0, 1000);
      if (!message) return sendJson(res, 400, { error: 'Type a message first' });
      const reply = await generateReply('dashboard-test', message, [], [], null, {});
      const clean = reply.startsWith('__HANDOFF__')
        ? '[Handoff triggered: the real bot would pass this to you] ' + reply.replace('__HANDOFF__', '').split('__REASON__')[0].trim()
        : reply;
      return sendJson(res, 200, { reply: clean });
    }
    return sendJson(res, 404, { error: 'Unknown API route' });
  } catch (e) {
    console.error('API error:', e.message);
    return sendJson(res, 500, { error: e.message });
  }
}

function isAuthorized(req) {
  if (!config.adminKey) return false;
  const u = new URL(req.url, 'http://localhost');
  const k = req.headers['x-admin-key'] || u.searchParams.get('key');
  return k === config.adminKey;
}

const server = http.createServer(async (req, res) => {
  const reqPath = req.url.split('?')[0];
  if ((['/clear-sessions', '/import', '/agent', '/stats'].includes(reqPath) || reqPath.startsWith('/api/')) && !isAuthorized(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized. Set ADMIN_KEY in Render env vars and open the URL with ?key=YOUR_ADMIN_KEY' }));
    return;
  }
  if (reqPath === '/' || reqPath === '/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(dashboardHtml);
  } else if (reqPath.startsWith('/api/')) {
    await handleApi(req, res, reqPath);
  } else if (reqPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), bot: global.botStatus || 'starting', timestamp: new Date().toISOString(), instanceId: global.instanceId || 'unknown' }));
  } else if (reqPath === '/clear-sessions' && (req.method === 'GET' || req.method === 'POST')) {
    // Clear Bad MAC sessions - fixes decryption errors
    try {
      const mem = await getMemoryStore();
      // Need auth redis - create temp auth to get clearSessions
      const { createAuthState } = await import('./auth.js');
      const authState = await createAuthState();
      let cleared = 0;
      if (authState.clearSessions) {
        cleared = await authState.clearSessions();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: `Cleared ${cleared} session keys to fix Bad MAC. Bot will re-establish sessions on next messages.`, cleared }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  } else if (reqPath === '/import' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Import Old Chats + Agent Control</title><style>body{font-family:system-ui;padding:20px;max-width:700px;margin:auto;background:#f5f5f5} .card{background:white;padding:20px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);margin-bottom:20px} textarea{width:100%;height:200px;padding:12px;border:1px solid #ddd;border-radius:8px;font-family:monospace;font-size:13px} input,button{padding:12px;border-radius:8px;border:1px solid #ddd;margin:5px 0;width:100%} button{background:#25D366;color:white;border:none;font-weight:bold;cursor:pointer} button:hover{background:#128C7E} .info{background:#e8f5e9;padding:12px;border-radius:8px;margin:10px 0;font-size:14px} .agent{background:#fff3e0;padding:12px;border-radius:8px;margin:10px 0}</style></head><body>
<h2>📚 Import Old Chats + 🤖 Agent Control</h2>
<div class="card"><h3>Import Old Chats</h3><div class="info">Export: WhatsApp → Chat → 3 dots → More → Export → Without media → Copy .txt</div><label>Number (234...):</label><input id="jid" placeholder="2348012345678" /><label>Your name in export:</label><input id="ownerName" placeholder="You" value="You" /><label>Paste .txt:</label><textarea id="chatText"></textarea><button onclick="importChat()">📥 Import</button><div id="result"></div></div>
<div class="card"><h3>🤖 Agent Control - Message people with goals</h3><div class="agent"><b>How to use from your self-chat:</b><br>Just talk naturally! No / needed<br>Examples:<br>• "Greet 0901 434 7620, ask how they are, ma for female Sir for male"<br>• Share contacts via WhatsApp, then say "greet them all"<br>• "0901 434 7620 0811 003 3639 greet them"<br>• Old: /agent 234... | Goal: ...</div>
<label>Numbers (comma separated):</label><input id="agentNumbers" placeholder="2348012345678,2348023456789" />
<label>Goal / Task:</label><textarea id="agentGoal" placeholder="Greet them, ask how they are, and let them know the owner will reach out about the meeting."></textarea>
<button onclick="startAgent()">🚀 Start Agent Task</button><div id="agentResult"></div></div>
<div class="card"><h3>📊 Stats</h3><button onclick="loadStats()">Refresh</button><div id="stats"></div></div>
<script>
const KEY=new URLSearchParams(location.search).get('key')||'';
async function importChat(){const jid=document.getElementById('jid').value.trim();const ownerName=document.getElementById('ownerName').value.trim()||'You';const chatText=document.getElementById('chatText').value.trim();if(!jid||!chatText){alert('Enter number and chat');return;}document.getElementById('result').innerHTML='⏳...';try{const res=await fetch('/import',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':KEY},body:JSON.stringify({jid,ownerName,chatText})});const data=await res.json();document.getElementById('result').innerHTML='<div style="background:#e8f5e9;padding:12px;border-radius:8px">✅ '+data.message+'<br>Learned '+data.learned+'</div>';}catch(e){document.getElementById('result').innerHTML='❌ '+e.message;}}
async function startAgent(){const numbers=document.getElementById('agentNumbers').value.trim();const goal=document.getElementById('agentGoal').value.trim();if(!numbers||!goal){alert('Enter numbers and goal');return;}document.getElementById('agentResult').innerHTML='⏳ Starting...';try{const res=await fetch('/agent',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':KEY},body:JSON.stringify({numbers,goal})});const data=await res.json();document.getElementById('agentResult').innerHTML='<div style="background:#fff3e0;padding:12px;border-radius:8px">✅ '+data.message+'</div>';}catch(e){document.getElementById('agentResult').innerHTML='❌ '+e.message;}}
async function loadStats(){document.getElementById('stats').innerHTML='⏳...';try{const res=await fetch('/stats',{headers:{'x-admin-key':KEY}});const data=await res.json();let html='<p>Contacts: '+data.totalContacts+' | Active agent tasks: '+(data.agentTasks||0)+'</p>';for(const c of data.contacts){html+='<div style="border:1px solid #eee;padding:10px;margin:5px 0;border-radius:8px"><b>'+c.jid+'</b> - '+c.count+'<br><small>'+(c.preview||'').slice(0,80)+'</small></div>';}document.getElementById('stats').innerHTML=html;}catch(e){document.getElementById('stats').innerHTML='Error: '+e.message;}}loadStats();
</script></body></html>`);
  } else if (reqPath === '/import' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { jid, ownerName, chatText } = JSON.parse(body);
        if (!jid || !chatText) throw new Error('Missing');
        const mem = await getMemoryStore();
        const result = extractOwnerStyleFromExport(chatText, [ownerName, 'You']);
        const targetJid = jid.includes('@') ? jid : `${jid.replace(/[^0-9]/g,'')}@s.whatsapp.net`;
        let learned = 0;
        for (const s of result.styleSamples) { await mem.addOwnerMessage(targetJid, s); learned++; }
        for (const msg of result.conversation.slice(-20)) { await mem.addMessage(targetJid, msg.role, msg.role === 'assistant' ? `[${config.ownerName} himself] ${msg.content}` : msg.content); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Imported ${result.totalMessages} msgs (${result.ownerCount} you)`, learned }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: e.message })); }
    });
  } else if (reqPath === '/agent' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { numbers, goal } = JSON.parse(body);
        if (!numbers || !goal) throw new Error('Missing numbers or goal');
        const mem = await getMemoryStore();
        const agentManager = await getAgentManager(mem, global.sockRef);
        const nums = extractNumbersRobust(numbers);
        let started = 0;
        for (const num of nums) {
          const targetJid = `${num}@s.whatsapp.net`;
          const ownerJid = `${config.phoneNumber}@s.whatsapp.net`;
          await agentManager.createTask(targetJid, goal, ownerJid);
          const ownerStyle = await mem.getOwnerStyle(targetJid);
          const styleTexts = ownerStyle.map(s => s.content);
          const history = await mem.getHistory(targetJid);
          const initialMsg = await generateReply(targetJid, `Start conversation with goal: ${goal}. Write first message to contact as owner would.`, history, styleTexts, null);
          await global.sockRef.sendMessage(targetJid, { text: initialMsg });
          await mem.addMessage(targetJid, 'assistant', initialMsg);
          started++;
          await new Promise(r => setTimeout(r, 3000));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Started ${started} agent tasks with goal: ${goal}` }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: e.message })); }
    });
  } else if (reqPath === '/stats') {
    try {
      const mem = await getMemoryStore();
      let contacts = [];
      let agentTasks = 0;
      if (mem.isRedis && mem.redis && typeof mem.redis.keys === 'function') {
        const keys = await mem.redis.keys('owner:style:*');
        for (const key of keys.slice(0,20)) {
          const jid = key.replace('owner:style:', '');
          const samples = await mem.getOwnerStyle(jid);
          contacts.push({ jid, count: samples.length, preview: samples[0]?.content || '' });
        }
        const agentKeys = await mem.redis.keys('agent:task:*');
        agentTasks = agentKeys.length;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ totalContacts: contacts.length, contacts, agentTasks }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else { res.writeHead(404); res.end('Not found'); }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`🌐 Server on 0.0.0.0:${config.port} - /import and /agent available`);
  
  // Keep-alive: self-ping every 4 minutes to prevent Render free tier sleep (15 min idle)
  // This creates inbound HTTP request to self, which counts as activity for Render
  const KEEP_ALIVE_INTERVAL = 4 * 60 * 1000; // 4 minutes
  setInterval(async () => {
    try {
      const url = `http://127.0.0.1:${config.port}/health`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      console.log(`💓 Keep-alive ping: ${data.status || res.status} - uptime ${Math.floor(process.uptime())}s - ${new Date().toLocaleString('en-US', { timeZone: config.timezone })}`);
    } catch (e) {
      console.error(`💓 Keep-alive failed: ${e.message}`);
    }
  }, KEEP_ALIVE_INTERVAL);
  console.log(`💓 Keep-alive enabled: pinging /health every 4 minutes to prevent Render sleep`);
  
  // External ping every 5 minutes to public URL (if available) - backup
  const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '';
  if (PUBLIC_URL) {
    setInterval(async () => {
      try {
        const res = await fetch(`${PUBLIC_URL}/health`);
        console.log(`🌐 External keep-alive: ${PUBLIC_URL}/health -> ${res.status}`);
      } catch {}
    }, 4 * 60 * 1000);
  } else {
    console.warn('⚠️ RENDER_EXTERNAL_URL / PUBLIC_URL not set - external keep-alive disabled (use UptimeRobot on /health)');
  }
});

global.botStatus = 'starting';
global.sockRef = null;
validateConfig();

let sock = null;
let memory = null;
let auth = null;
let pairingCodeRequested = false;
let agentManager = null;
let isStarting = false;
let reconnectTimeout = null;
let instanceId = Math.random().toString(36).slice(2, 8);
global.instanceId = instanceId;
// Prevent double-reply when owner is typing / recently replied
const processingJids = new Set();
const recentlyProcessed = new Map(); // jid -> timestamp to debounce duplicate decrypts

async function setPaused(v) {
  global.botPaused = !!v;
  try { const mem = await getMemoryStore(); await mem.setBotPaused(!!v); } catch {}
  console.log(global.botPaused ? '⏸ Bot PAUSED (stays paused until YOU resume it)' : '▶️ Bot RESUMED');
}

async function notifyOwner(text) {
  try {
    if (global.settings && global.settings.alerts === false) return;
    if (!sock || global.botStatus !== 'connected') return;
    await sock.sendMessage(`${config.phoneNumber}@s.whatsapp.net`, { text });
  } catch (e) { console.warn('notifyOwner failed: ' + e.message); }
}

// While paused the bot does not reply, but it still saves what people send so you can read it in the Chats tab.
async function logWhilePaused(msg) {
  try {
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@newsletter')) return;
    const { text, mediaInfo } = await extractContent(msg);
    const t = text || (mediaInfo ? `[${mediaInfo.type}]` : '');
    if (!t) return;
    global.stats.received++;
    trackChat(jid, { name: msg.pushName, role: 'contact', text: t, ts: Number(msg.messageTimestamp || 0) * 1000 });
    console.log(`⏸ Paused: saved message from ${jid.split('@')[0]} without replying`);
  } catch {}
}

// Each chat has its own queue (messages inside a chat are answered in order, different chats run in parallel).
// If several messages from one person are waiting, only the LAST one gets a reply (it sees all of them in history).
const jidChains = new Map();
const jidPending = new Map();
const jidLastArrival = new Map();   // when this person last sent something (for the quiet window)
const lastReaction = new Map();
// Recent messages from each person (kept in memory) so a reply can point at one exact message (WhatsApp swipe-reply)
const recentIncoming = new Map();
const lastQuote = new Map();
function rememberIncoming(jid, msg, text) {
  const list = recentIncoming.get(jid) || [];
  list.push({ id: msg.key && msg.key.id, msg, text: String(text || '').slice(0, 300), ts: Date.now() });
  while (list.length > 10) list.shift();
  recentIncoming.delete(jid); recentIncoming.set(jid, list);
  if (recentIncoming.size > 200) recentIncoming.delete(recentIncoming.keys().next().value);
}
function agoText(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 2 ? 'a moment ago' : m < 60 ? `${m} minutes ago` : m < 1440 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`;
}
     // when the AI last reacted to this person
const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
function enqueueMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!jid) return;
  const run = () => handleMessage(msg).catch(err => console.error(`[${instanceId}] Error handling message:`, err));
  if (msg.key.fromMe) { run(); return; } // owner's own messages must never wait behind a bot reply
  if (global.botPaused) { logWhilePaused(msg); return; }
  global.stats.received++;
  jidLastArrival.set(jid, Date.now());
  jidPending.set(jid, (jidPending.get(jid) || 0) + 1);
  const prev = jidChains.get(jid) || Promise.resolve();
  const next = prev.then(run).finally(() => {
    const n = (jidPending.get(jid) || 1) - 1;
    if (n <= 0) { jidPending.delete(jid); jidChains.delete(jid); } else jidPending.set(jid, n);
  });
  jidChains.set(jid, next);
}

async function startBot() {
  if (isStarting) {
    console.log(`⚠️ [${instanceId}] startBot already in progress, skipping duplicate start`);
    return;
  }
  isStarting = true;
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  try {
    console.log('\n' + '='.repeat(60));
    console.log(`🚀 WhatsApp AI Bot - Ghost + Style + Import + Media + SUPER AGENT [${instanceId}]`);
    console.log('='.repeat(60));
    memory = await getMemoryStore();
    await loadSettings();
    try { global.botPaused = await memory.getBotPaused(); if (global.botPaused) console.log('⏸ Bot is PAUSED (saved setting). Tap Resume on the dashboard Home screen to turn it back on.'); } catch {}
    auth = await createAuthState();
    
    // Auto-clear old corrupted sessions that cause Bad MAC - one time fix
    if (auth.clearSessions) {
      try {
        const shouldAutoClear = process.env.AUTO_CLEAR_SESSIONS === 'true';
        if (shouldAutoClear) {
          console.log(`🧹 Checking for old corrupted sessions that cause Bad MAC...`);
          const cleared = await auth.clearSessions();
          if (cleared > 0) {
            console.log(`✅ Auto-cleared ${cleared} old session keys - Bad MAC should be fixed now`);
          } else {
            console.log(`✅ No old sessions to clear - sessions are clean`);
          }
        }
      } catch (e) {
        console.log(`⚠️ Auto-clear sessions failed: ${e.message}`);
      }
    }
    
    // Only auto-connect when this bot is already linked to WhatsApp. A new link (and the code WhatsApp sends to your phone)
    // only happens when you tap "Connect WhatsApp" in the dashboard (or set AUTO_PAIR=true).
    if (!isLinked() && process.env.AUTO_PAIR !== 'true' && !global.manualConnect) {
      global.botStatus = 'not-linked';
      console.log('🔗 Not linked to WhatsApp yet. Open the dashboard and tap "Connect WhatsApp". No code is requested automatically.');
      isStarting = false;
      return;
    }

    agentManager = await getAgentManager(memory, null);
    const { version } = await fetchLatestBaileysVersion();
    console.log(`📦 Baileys version: ${version.join('.')} [${instanceId}]`);
    const logger = pino({ level: 'silent' });
    sock = makeWASocket({
      version, auth: auth.state, logger,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
    });
    global.sockRef = sock;
    agentManager.sock = sock;
    const rememberNames = (list) => {
      for (const c of list || []) {
        const n = c.name || c.notify || c.verifiedName;
        if (c.id && n) global.contactNames.set(c.id, n);
      }
    };
    sock.ev.on('contacts.upsert', rememberNames);
    sock.ev.on('contacts.update', rememberNames);
    sock.ev.on('messaging-history.set', (h) => rememberNames(h && h.contacts));

    if (process.env.AUTO_PAIR === 'true' && !isLinked() && config.phoneNumber && !pairingCodeRequested) {
      setTimeout(async () => {
        try {
          if (!isLinked()) {
            console.log(`\n📱 [${instanceId}] Requesting pairing code for ${config.phoneNumber}...`);
            const code = await sock.requestPairingCode(config.phoneNumber);
            console.log('\n' + '█'.repeat(60));
            console.log(`🔑 YOUR PAIRING CODE: ${code}`);
            console.log('█'.repeat(60));
            pairingCodeRequested = true;
          }
        } catch (err) {
          console.error(`❌ [${instanceId}] Pairing code failed:`, err.message);
          pairingCodeRequested = false;
          isStarting = false;
          reconnectTimeout = setTimeout(() => { if (!isLinked()) startBot(); }, 15000);
        }
      }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && !config.phoneNumber) { qrcode.generate(qr, { small: true }); }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'unknown';
        console.log(`\n🔌 [${instanceId}] Closed. Status: ${statusCode}, Reason: ${reason}`);
        global.botStatus = `disconnected-${statusCode}`;
        
        // Clear sock reference
        try { if (sock) { await sock.end(); } } catch {}
        if (global.sockRef === sock) global.sockRef = null;
        
        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`🚪 [${instanceId}] Logged out - clearing auth state, need re-pair`);
          if (auth.clearState) await auth.clearState();
          global.manualConnect = false;
          global.pairing = null;
          global.botStatus = 'not-linked';
          isStarting = false;
          return;
        }
        
        // 440 = Stream Errored (conflict) - another instance is running
        if (statusCode === 440) {
          console.log(`⚠️ [${instanceId}] 440 CONFLICT - Another instance is fighting for connection! Waiting 25s before retry to avoid Bad MAC errors...`);
          console.log(`⚠️ [${instanceId}] This causes "Failed to decrypt" and no response - need single instance`);
          global.botStatus = 'conflict-440-waiting-25s';
          isStarting = false;
          // Wait much longer for 440 to let other instance die
          reconnectTimeout = setTimeout(() => {
            console.log(`🔄 [${instanceId}] Retrying after 440 conflict wait...`);
            startBot();
          }, 25000 + Math.random() * 10000); // 25-35s
          return;
        }
        
        // Other disconnects - wait 8s
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log(`🔄 [${instanceId}] Will reconnect in 8s...`);
          isStarting = false;
          reconnectTimeout = setTimeout(startBot, 8000);
        } else {
          isStarting = false;
        }
      } else if (connection === 'open') {
        console.log(`\n✅ [${instanceId}] Connected! Ghost + Style + Media + SUPER AGENT ON`);
        console.log(`📞 [${instanceId}] As: ${sock.user?.id || 'unknown'}`);
        console.log(`📚 [${instanceId}] Import: /import | Agent: /agent | Natural language: ON | Time: ${config.timezone}`);
        global.botStatus = 'connected';
        global.pairing = null;
        startSummaryScheduler(() => sock);
        startSchedulers(() => sock);
        pairingCodeRequested = false;
        isStarting = false;
      } else if (connection === 'connecting') {
        console.log(`⏳ [${instanceId}] Connecting...`);
        global.botStatus = 'connecting';
      }
    });

    sock.ev.on('creds.update', auth.saveCreds);
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const msg of messages) {
        if (type !== 'notify') {
          // 'append' = messages that arrived while offline / reconnecting. Answer recent ones only.
          const ts = Number(msg.messageTimestamp || 0) * 1000;
          if (type !== 'append' || msg.key.fromMe || !ts || Date.now() - ts > 10 * 60 * 1000) continue;
        }
        enqueueMessage(msg);
      }
    });

  } catch (err) {
    console.error(`❌ [${instanceId}] Fatal:`, err);
    global.botStatus = 'error';
    isStarting = false;
    reconnectTimeout = setTimeout(startBot, 15000);
  } finally {
    // isStarting will be cleared on open or close, but ensure not stuck
    // Don't clear here if connecting, let connection.update clear it
  }
}

async function handleMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!jid) return;
  if (jid === 'status@broadcast' || jid.includes('@newsletter')) return;
  if (config.ignoreGroups && jid.endsWith('@g.us')) return;

  const isFromMe = msg.key.fromMe;
  const contactName = msg.pushName || jid.split('@')[0];
  const m = msg.message;
  let { text: messageContent, mediaInfo } = await extractContent(msg);
  const ownerJid = `${config.phoneNumber}@s.whatsapp.net`;
  const isSelfChat = jid === ownerJid || jid === `${config.phoneNumber}@s.whatsapp.net`;

  // Dashboard Chats tab: log what the contact wrote, or what you wrote yourself from your phone
  if (!isSelfChat && !jid.endsWith('@g.us')) {
    const preview = messageContent || (mediaInfo ? `[${mediaInfo.type}]` : '');
    if (preview && !isFromMe) rememberIncoming(jid, msg, preview);
    if (preview) trackChat(jid, { name: isFromMe ? null : msg.pushName, role: isFromMe ? 'owner' : 'contact', text: preview, ts: Number(msg.messageTimestamp || 0) * 1000 });
  }

  // Per-contact switch: when "AI replies to this person" is OFF, save what they send but never answer
  if (!isFromMe && !isSelfChat && !jid.endsWith('@g.us')) {
    try {
      const prof = await memory.getContactProfile(jid);
      if (prof && prof.botOff) {
        const t = messageContent || (mediaInfo ? `[${mediaInfo.type}]` : '');
        if (t) await memory.addMessage(jid, 'user', t);
        console.log(`🔕 AI is turned OFF for ${msg.pushName || jid.split('@')[0]}: message saved, no reply`);
        return;
      }
    } catch (e) { console.warn('botOff check failed:', e.message); }
  }

  // Quiet hours: during these hours messages are saved but not answered
  if (!isFromMe && !isSelfChat && !jid.endsWith('@g.us') && global.settings.quietHoursEnabled) {
    try {
      const q = global.settings;
      const nowMin = localNow().minutes;
      const f = parseInt(q.quietFrom.slice(0, 2), 10) * 60 + parseInt(q.quietFrom.slice(3), 10);
      const t = parseInt(q.quietTo.slice(0, 2), 10) * 60 + parseInt(q.quietTo.slice(3), 10);
      const inQuiet = f <= t ? (nowMin >= f && nowMin < t) : (nowMin >= f || nowMin < t);
      if (inQuiet) {
        const txt = messageContent || (mediaInfo ? `[${mediaInfo.type}]` : '');
        if (txt) await memory.addMessage(jid, 'user', txt);
        console.log(`🌙 Quiet hours: saved the message from ${msg.pushName || jid.split('@')[0]}, not answering`);
        return;
      }
    } catch {}
  }

  // Document import
  if (isFromMe && m?.documentMessage) {
    try {
      const doc = m.documentMessage;
      const fileName = doc.fileName || '';
      if (fileName.endsWith('.txt') || doc.mimetype === 'text/plain') {
        console.log('📚 Detected chat export .txt');
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        const text = buffer.toString('utf-8');
        const result = extractOwnerStyleFromExport(text, ['You', contactName, '']);
        if (result.styleSamples.length > 0) {
          let imported = 0;
          for (const sample of result.styleSamples) { await memory.addOwnerMessage(jid, sample); imported++; }
          await sock.sendMessage(jid, { text: `✅ Imported ${imported} msgs from old chat with ${result.contactName}!` });
          return;
        }
      }
    } catch (e) { console.error('Document import error:', e.message); }
  }

  if (isFromMe) {
    // ===== SELF-CHAT SUPER INTELLIGENT AGENT =====
    if (isSelfChat) {
      if (messageContent && /^(🙋 \*Needs you\*|📋 \*Daily summary|⚠️ \*Handoff Alert\*)/.test(messageContent)) return; // the bot's own notification
      // 1. Handle contact sharing (vCard)
      if (mediaInfo && mediaInfo.type === 'contact') {
        const numbers = mediaInfo.numbers || [];
        if (numbers.length > 0) {
          await agentManager.saveRecentSharedContacts(ownerJid, numbers);
          console.log(`📇 Owner shared ${numbers.length} contacts in self-chat: ${numbers.join(', ')}`);
          // If message also has instruction, trigger immediately
          if (messageContent && messageContent.length > 5 && !messageContent.startsWith('[Contact')) {
            const intent = await parseNaturalAgentIntent(`${numbers.join(' ')} ${messageContent}`, numbers);
            if (intent) {
              await handleAgentCommand(intent, jid);
              return;
            }
          }
          // If only contacts shared without instruction, store and acknowledge subtly
          if (!messageContent || messageContent.startsWith('[Contact') || messageContent.length < 10) {
            // Don't spam, just store silently, but if many contacts, give hint
            if (numbers.length >= 3) {
              await sock.sendMessage(jid, { text: `📇 Got ${numbers.length} contacts: ${numbers.join(', ')}\n\nTell me what to do with them - e.g. "greet them as ma/Sir" or "ask about project"` });
            }
            return;
          }
        }
      }

      // 2. Check explicit /agent commands first (old style still works)
      if (messageContent) {
        const agentCmd = parseAgentCommand(messageContent);
        if (agentCmd) {
          await handleAgentCommand(agentCmd, jid);
          return;
        }
        const cmd = parseOwnerCommand(messageContent);
        if (cmd) { await handleOwnerCommand(cmd, jid); return; }
      }

      // 3. SUPER INTELLIGENT natural language detection (no slash needed)
      if (messageContent) {
        try {
          const recentContacts = await agentManager.getRecentSharedContacts(ownerJid);
          const naturalIntent = await parseNaturalAgentIntent(messageContent, recentContacts);
          if (naturalIntent && naturalIntent.numbers.length > 0) {
            console.log(`🧠 Natural intent in self-chat: ${naturalIntent.numbers.length} numbers, goal: ${naturalIntent.goal.slice(0,100)}`);
            await handleAgentCommand(naturalIntent, jid);
            return;
          }
          // If message is just numbers without instruction but looks like a list, save as recent
          const onlyNumbers = extractNumbersRobust(messageContent);
          const textWithoutNumbers = messageContent.replace(/[0-9,\s\-\+\(\)]+/g, '').trim();
          if (onlyNumbers.length >= 1 && textWithoutNumbers.length < 3) {
            await agentManager.saveRecentSharedContacts(ownerJid, onlyNumbers);
            await sock.sendMessage(jid, { text: `📇 Saved ${onlyNumbers.length} numbers: ${onlyNumbers.join(', ')}\n\nWhat should I do with them? e.g. "greet them, ask how they are, ma for female Sir for male"` });
            return;
          }
        } catch (e) { console.error('Natural intent error:', e.message); }
      }

      // 4. Check for away/back toggle - manual control for #2
      if (messageContent) {
        const lowerSelf = messageContent.toLowerCase().trim();
        if (['away', 'i am away', "i'm away", 'brb', 'busy', 'go away', 'enable bot', 'bot on', 'assistant on'].includes(lowerSelf) || lowerSelf.startsWith('away ') || lowerSelf === 'away mode on') {
          try {
            await setPaused(false);
            await sock.sendMessage(jid, { text: `▶️ Assistant is ON. It replies to your contacts until you send "back" here or tap Pause on the dashboard.` });
            console.log(`🌙 Owner set AWAY mode via self-chat: ${messageContent}`);
          } catch {}
          return;
        }
        if (['back', 'i am back', "i'm back", 'i am online', 'online', 'i am here', 'back online', 'disable bot', 'bot off', 'assistant off', 'pause all', 'quiet'].includes(lowerSelf) || lowerSelf.startsWith('back ') || lowerSelf === 'away mode off') {
          try {
            await setPaused(true);
            await sock.sendMessage(jid, { text: `⏸ Assistant PAUSED. It will not reply to anyone until you send "away" here or tap Resume on the dashboard.` });
            console.log(`✅ Owner set BACK mode via self-chat: ${messageContent}`);
          } catch {}
          return;
        }
      }

      // 5. If self-chat and no command, learn style but also keep as note
      if (messageContent && !messageContent.startsWith('/')) {
        await memory.addOwnerMessage(jid, messageContent);
        await memory.addMessage(jid, 'assistant', messageContent);
        console.log(`📝 Self-chat note: "${messageContent.slice(0,80)}..."`);
      }
      return;
    }

    // Not self-chat, but owner messaging someone else - learn style + TAKE OVER
    // CRITICAL: When YOU (real owner) reply, bot must STOP and not interfere with already-handled chat
    try {
      console.log(`👤 You replied to ${contactName} yourself. The bot is NOT paused automatically (use the Pause button on Home if you want it quiet).`);
      // If there was an active agent task, pause it too - owner is handling manually
      if (agentManager) {
        try {
          const existingTask = await agentManager.getTask(jid);
          if (existingTask) {
            console.log(`🤖 Pausing agent task for ${jid} because owner took over`);
            await agentManager.completeTask(jid, 'Paused - owner took over manually');
          }
        } catch {}
      }
    } catch (e) { console.error('Owner takeover error:', e.message); }

    if (messageContent) {
      const agentCmd = parseAgentCommand(messageContent);
      if (agentCmd) {
        await handleAgentCommand(agentCmd, jid);
        return;
      }
      const cmd = parseOwnerCommand(messageContent);
      if (cmd) { await handleOwnerCommand(cmd, jid); return; }
      if (messageContent && !messageContent.startsWith('/')) {
        if (global.settings.learnFromReplies) await memory.addOwnerMessage(jid, messageContent);
        await memory.addMessage(jid, 'assistant', `[${config.ownerName} himself] ${messageContent}`);
        console.log(`📝 Learned YOUR style for ${contactName}: "${messageContent.slice(0,50)}..."`);
      }
    }
    return;
  }

  if (!messageContent && !mediaInfo) return;


  // Debounce duplicate decrypts (Baileys sometimes fires same message twice)
  const msgId = msg.key.id;
  if (msgId) {
    const lastProcessed = recentlyProcessed.get(msgId);
    if (lastProcessed && Date.now() - lastProcessed < 30000) {
      console.log(`⏭️ Duplicate ${msgId} from ${jid} - processed ${((Date.now()-lastProcessed)/1000).toFixed(1)}s ago, skipping`);
      return;
    }
    recentlyProcessed.set(msgId, Date.now());
    if (recentlyProcessed.size > 200) {
      const cutoff = Date.now() - 60000;
      for (const [k,v] of recentlyProcessed.entries()) if (v < cutoff) recentlyProcessed.delete(k);
    }
  }

  // Prevent concurrent processing of same chat

  console.log(`\n📩 From ${contactName} (${jid}): ${messageContent?.slice(0,100)} ${mediaInfo ? `[${mediaInfo.type}]` : ''}`);

  const activeTask = await agentManager.getTask(jid);
  if (activeTask) {
    console.log(`🤖 Agent task active for ${jid}: ${activeTask.goal}`);
    // Transcribe voice/video for agent tasks too
    if (mediaInfo && (mediaInfo.type === 'voice' || mediaInfo.type === 'audio' || mediaInfo.type === 'video')) {
      try {
        console.log(`📥 Agent: Downloading ${mediaInfo.type} for transcription...`);
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        const transcribed = await transcribeAudio(buffer, mediaInfo.mimeType || 'audio/ogg');
        if (transcribed) {
          console.log(`🎙️ Agent voice transcribed: "${transcribed.slice(0,100)}..."`);
          messageContent = transcribed;
          mediaInfo.transcription = transcribed;
        }
      } catch (e) {
        console.error(`❌ Agent transcription failed: ${e.message}`);
      }
    }
    await handleAgentReply(jid, messageContent, mediaInfo, activeTask);
    return;
  }

  if (await memory.isHandoff(jid)) {
    console.log(`⏸️ Paused for ${jid}`);
    await memory.addMessage(jid, 'user', messageContent || `[${mediaInfo?.type || 'media'}]`);
    return;
  }

  if (await memory.isRateLimited(jid)) {
    const count = await memory.getRateLimitCount(jid);
    if (count === config.maxPerHour + 1) {
      await delay(1000);
      await sock.sendMessage(jid, { text: "Sorry, give me a minute and I'll reply you 🙏" });
    }
    return;
  }

  // Mark as processing to prevent double replies
  processingJids.add(jid);
  try {
    const historyText = messageContent || (mediaInfo ? `[${mediaInfo.type} ${mediaInfo.caption ? ': ' + mediaInfo.caption : ''}]` : '');
    await memory.addMessage(jid, 'user', historyText);
    const pendingAtStart = jidPending.get(jid) || 0;
    const settingsNow = global.settings;

    // Answer together: wait until the person has stopped typing (quiet window), then reply once to everything they sent.
    // One by one: no waiting, every message gets its own reply, in order.
    if (settingsNow.burstBatching && !mediaInfo) {
      const quiet = settingsNow.quietSeconds * 1000;
      const started = Date.now();
      while (true) {
        if ((jidPending.get(jid) || 0) > 1) { console.log(`⏭️ ${contactName} sent more: the next message will answer for all of them`); return; }
        const since = Date.now() - (jidLastArrival.get(jid) || 0);
        if (since >= quiet || Date.now() - started >= 20000) break;
        await sleepMs(Math.min(400, quiet - since + 50));
      }
    }

    // Global limit: stop replying if the bot already sent too many replies this hour
    global.replyTimes = global.replyTimes.filter(t => t > Date.now() - 3600 * 1000);
    if (global.replyTimes.length >= settingsNow.maxPerHourGlobal) { console.log(`🚦 Global limit of ${settingsNow.maxPerHourGlobal} replies/hour reached: not answering ${contactName}`); return; }
    if (settingsNow.humanTyping) { sock.readMessages([msg.key]).catch(() => {}); }
    const history = await memory.getHistory(jid);
    const ownerStyle = await memory.getOwnerStyle(jid);
    const ownerStyleTexts = ownerStyle.map(s => s.content);
    console.log(`🎭 Style samples for ${contactName}: ${ownerStyleTexts.length}, Media: ${mediaInfo?.type || 'none'}`);

    // ===== HUMAN-LIKE TIMING: Seen delay (no typing yet) =====
    // Real person glances at phone after random gap, not instantly
    const wantedDelayMs = Math.round((settingsNow.delayMin + Math.random() * Math.max(0, settingsNow.delayMax - settingsNow.delayMin)) * 1000);
    const delayStartedAt = Date.now();

    let mediaForAI = null;
    let transcribedText = null;
    
    if (mediaInfo && (mediaInfo.type === 'image' || mediaInfo.type === 'sticker')) {
      try {
        console.log(`📥 Downloading ${mediaInfo.type} for AI...`);
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        const base64 = buffer.toString('base64');
        mediaForAI = { type: mediaInfo.type, base64, mimeType: mediaInfo.mimeType || (mediaInfo.type === 'sticker' ? 'image/webp' : 'image/jpeg'), caption: mediaInfo.caption || '', emoji: mediaInfo.emoji || '' };
        console.log(`✅ Downloaded ${mediaInfo.type}: ${buffer.length} bytes`);
      } catch (e) { console.error(`❌ Failed download ${mediaInfo.type}:`, e.message); }
    } else if (mediaInfo && (mediaInfo.type === 'voice' || mediaInfo.type === 'audio')) {
      try {
        console.log(`📥 Downloading ${mediaInfo.type} for transcription...`);
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        console.log(`✅ Downloaded ${mediaInfo.type}: ${buffer.length} bytes, transcribing...`);
        transcribedText = await transcribeAudio(buffer, mediaInfo.mimeType || 'audio/ogg');
        if (transcribedText) {
          console.log(`🎙️ Voice transcribed to: "${transcribedText.slice(0,120)}..."`);
          // Use transcribed text as the actual message content
          messageContent = transcribedText;
          // Keep media info for context
          mediaForAI = { type: mediaInfo.type, transcription: transcribedText, mimeType: mediaInfo.mimeType };
        } else {
          console.log(`⚠️ Voice transcription failed, will handle as voice note`);
          mediaForAI = { type: mediaInfo.type, transcription: null, mimeType: mediaInfo.mimeType };
        }
      } catch (e) { console.error(`❌ Failed download/transcribe ${mediaInfo.type}:`, e.message); }
    } else if (mediaInfo && mediaInfo.type === 'video') {
      try {
        // If video has caption, use caption, but also try to transcribe audio
        if (!mediaInfo.caption || mediaInfo.caption.length < 5) {
          console.log(`📥 Downloading video for transcription...`);
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
          console.log(`✅ Downloaded video: ${buffer.length} bytes, trying transcription...`);
          transcribedText = await transcribeAudio(buffer, mediaInfo.mimeType || 'video/mp4');
          if (transcribedText) {
            console.log(`🎬 Video audio transcribed: "${transcribedText.slice(0,120)}..."`);
            const captionPart = mediaInfo.caption ? `${mediaInfo.caption} ` : '';
            messageContent = `${captionPart}[Video says: ${transcribedText}]`.trim();
            mediaForAI = { type: 'video', transcription: transcribedText, caption: mediaInfo.caption || '', mimeType: mediaInfo.mimeType };
          }
        }
      } catch (e) { console.error(`❌ Failed video transcription:`, e.message); }
    }

    // If we have transcription, use it as the message, otherwise use original
    const finalMessageForAI = transcribedText || messageContent || historyText;
    
    // Which recent messages the AI may point at (only in "Smart" mode; the AI decides which one, if any)
    let quoteChoices = [];
    if ((settingsNow.quoteReplies || 'smart') === 'smart') {
      const recent = (recentIncoming.get(jid) || []).slice(-6);
      if (recent.length >= 2) quoteChoices = recent.map((r, i) => ({ n: i + 1, text: r.text.slice(0, 140), ago: agoText(r.ts), msg: r.msg }));
    }
    const aiMeta = {};
    const aiReply = await generateReply(jid, finalMessageForAI, history.slice(0, -1), ownerStyleTexts, mediaForAI, { meta: aiMeta, quoteChoices: quoteChoices.map(({ n, text, ago }) => ({ n, text, ago })) });

    // ===== SEND: wait the delay you chose, react, then send 1-3 message parts =====
    const ms = TYPING_MS_PER_CHAR[settingsNow.typingSpeed] || 30;
    const typingMs = (text) => Math.round(Math.min(9000, Math.max(500, text.length * ms)) * (0.85 + Math.random() * 0.3));
    await delay(Math.max(0, wantedDelayMs - (Date.now() - delayStartedAt)));   // AI time counts toward the delay

    const parts = (aiMeta.parts && aiMeta.parts.length) ? aiMeta.parts : (aiReply ? [aiReply] : []);

    if (aiMeta.react && settingsNow.emojiReactions) {
      const isSticker = !!(mediaInfo && mediaInfo.type === 'sticker');
      const waitMs = isSticker ? 60 * 1000 : 15 * 60 * 1000;   // max 1 reaction per 15 min per person (1 per minute for stickers)
      if (Date.now() - (lastReaction.get(jid) || 0) >= waitMs) {
        try {
          await sock.sendMessage(jid, { react: { text: aiMeta.react, key: msg.key } });
          lastReaction.set(jid, Date.now());
          global.stats.replied++;
          global.replyTimes.push(Date.now());
          trackChat(jid, { role: 'bot', text: `(reacted ${aiMeta.react})` });
          console.log(`😀 Reacted ${aiMeta.react} to ${contactName}`);
        } catch (e) { console.warn('Reaction failed: ' + e.message); }
      }
    }
    if (!parts.length) { return; }   // reaction only

    // Swipe-reply (quote) logic: Off = never. Always = every reply points at the message it answers.
    // Smart = one by one with several messages waiting: always tie the reply to its message; otherwise the AI picks (rarely, with a 2 minute pause between quotes).
    const quoteMode = settingsNow.quoteReplies || 'smart';
    let quotedMsg = null, quotedText = '';
    if (quoteMode === 'always') { quotedMsg = msg; quotedText = messageContent || historyText || ''; }
    else if (quoteMode === 'smart') {
      if (!settingsNow.burstBatching && Math.max(pendingAtStart, jidPending.get(jid) || 0) > 1) { quotedMsg = msg; quotedText = messageContent || historyText || ''; }
      else if (aiMeta.quote > 0 && quoteChoices[aiMeta.quote - 1] && Date.now() - (lastQuote.get(jid) || 0) > 2 * 60 * 1000) {
        quotedMsg = quoteChoices[aiMeta.quote - 1].msg; quotedText = quoteChoices[aiMeta.quote - 1].text; lastQuote.set(jid, Date.now());
      }
    }
    const quote = quotedMsg ? { quoted: quotedMsg } : undefined;
    for (let k = 0; k < parts.length; k++) {
      if (settingsNow.humanTyping) { await sock.sendPresenceUpdate('composing', jid); await delay(typingMs(parts[k])); }
      await sock.sendMessage(jid, { text: parts[k] }, k === 0 && quote ? quote : undefined);
      if (settingsNow.humanTyping) await sock.sendPresenceUpdate('paused', jid);
      trackChat(jid, { role: 'bot', text: parts[k], quote: k === 0 && quotedMsg ? quotedText : '' });
      if (k < parts.length - 1) await delay(getRandomInt(600, 1500));
    }
    const sentText = parts.join('\n');
    global.stats.replied++;
    global.replyTimes.push(Date.now());
    console.log(`🤖 Assistant replied to ${contactName}${parts.length > 1 ? ` (${parts.length} parts)` : ''}: ${sentText.slice(0,100)}...`);
    await memory.addMessage(jid, 'assistant', sentText);
    recordExchange({ jid, name: contactName, incoming: messageContent, reply: sentText });
    if (aiMeta.needsOwner) notifyOwner(`🙋 *Needs you*

${contactName} (+${jid.split('@')[0]})${aiMeta.note ? ': ' + aiMeta.note : ' needs you'}

Their message: "${(messageContent || '').slice(0, 220)}"

${config.assistantName} told them you'll get back to them.`);
    
        await sock.sendPresenceUpdate('paused', jid);

  } catch (err) {
    console.error(`Error replying to ${jid}:`, err);
    try { await sock.sendMessage(jid, { text: "Sorry, something went wrong on my side. I'll reply you shortly 🙏" }); } catch {}
  } finally {
    processingJids.delete(jid);
  }
}

async function handleAgentCommand(agentCmd, ownerJid) {
  console.log(`🤖 Agent command from ${ownerJid}:`, agentCmd);
  const { numbers, goal } = agentCmd;
  
  let started = 0;
  let failed = 0;
  
  try {
    const hint = agentCmd.isNatural ? '🧠 Natural language detected' : '🤖 Agent command';
    await sock.sendMessage(ownerJid, { text: `${hint}\n\nTargets: ${numbers.length} numbers\nGoal: ${goal}\n\nI will message them one by one and bring discussion to end. Reporting progress here...` });
  } catch (e) { console.error('Failed to send starting msg to owner:', e.message); }

  for (const num of numbers) {
    try {
      const targetJid = `${num}@s.whatsapp.net`;
      console.log(`🤖 Creating agent task for ${targetJid} with goal: ${goal}`);
      await agentManager.createTask(targetJid, goal, ownerJid);
      
      const ownerStyle = await memory.getOwnerStyle(targetJid);
      const styleTexts = ownerStyle.map(s => s.content);
      const history = await memory.getHistory(targetJid);
      
      let genderHint = 'unknown';
      const styleCombined = styleTexts.join(' ').toLowerCase();
      // Check for ma'am, ma, madam, etc.
      if (styleCombined.includes("ma'am") || styleCombined.includes('maam') || styleCombined.includes(' ma ') || styleCombined.includes(' ma,') || styleCombined.match(/\bma\b.*\?/) || styleCombined.includes(' madam') || styleCombined.includes(' sis') || styleCombined.includes(' aunty')) {
        // Check if goal explicitly says ma'am
        if (goal.toLowerCase().includes("ma'am") || goal.toLowerCase().includes('maam')) {
          genderHint = "female - address as ma'am";
        } else {
          genderHint = 'female - address as ma';
        }
      } else if (styleCombined.includes(' sir')) {
        genderHint = 'male - address as Sir';
      }
      const historyText = history.map(h => h.content).join(' ').toLowerCase();
      if (genderHint === 'unknown') {
        if (historyText.includes("ma'am") || historyText.includes('maam')) genderHint = "female - address as ma'am";
        else if (historyText.includes(' ma ') || historyText.includes(' madam')) genderHint = 'female - address as ma';
        else if (historyText.includes(' sir ')) genderHint = 'male - address as Sir';
      }
      // Override if goal says ma'am
      if (goal.toLowerCase().includes("ma'am") || goal.toLowerCase().includes('maam')) {
        genderHint = "female - address as ma'am";
      }
      console.log(`🎭 Gender hint for ${targetJid}: ${genderHint} (from ${styleTexts.length} samples)`);
      
      // Local time awareness
      const timeCtx = getNigerianTimeContext();
      
      let initialMsg = '';
      try {
        let genderInstruction = '';
        if (goal.toLowerCase().includes(' ma ') || goal.toLowerCase().includes(' sir') || goal.toLowerCase().includes('female') || goal.toLowerCase().includes('male')) {
          genderInstruction = `IMPORTANT: ${goal}. For gender: ${genderHint}. If female use "ma", if male use "Sir" based on previous chat style. ${genderHint !== 'unknown' ? `This contact is likely ${genderHint}, so use that title.` : 'Detect gender from how owner called them before (ma for female, Sir for male).'}`;
        } else {
          genderInstruction = goal;
        }
        
        const initialPrompt = `AGENT OUTREACH: You are ${config.assistantName}, ${config.ownerName}'s AI assistant, sending the FIRST message to this contact.

Goal for this contact: ${genderInstruction}

Context:
- Contact: ${targetJid.split('@')[0]}
- Detected gender hint: ${genderHint}
- TIME: ${timeCtx.formatted} - ${timeCtx.greetingInstruction}
- Tone reference: ${styleTexts.slice(-3).join(' | ').slice(0,200)}

STRICT RULES:
- You are an AI assistant, not ${config.ownerName}. Say so briefly if this is your first message to them.
- NO money, accounts, bank or payment talk. NO romantic or flirty tone.
- If the goal asks for anything financial, romantic or sensitive, don't do it; say ${config.ownerName} will reach out directly.
- Keep it short (1-2 lines), friendly, use "${timeCtx.greeting}" for ${timeCtx.period}. Use ma/Sir only if gender is known.

Write ONLY the first message.`;
        // For agent proactive messages, check if should disclose
        let agentShouldDisclose = false;
        try {
          agentShouldDisclose = await memory.shouldDisclose(targetJid);
          if (history.length <= 1) agentShouldDisclose = true; // New contact
        } catch {}
        
        initialMsg = await generateReply(targetJid, initialPrompt, history, styleTexts, null, { shouldDisclose: agentShouldDisclose, skipPreChecks: true, isAgentTask: true });
        console.log(`🤖 Generated initial msg for ${targetJid} (disclose=${agentShouldDisclose}): ${initialMsg.slice(0,120)}...`);
        
        // CRITICAL FIX: Never leak __HANDOFF__ flag to contact - strip it
        if (initialMsg.startsWith('__HANDOFF__')) {
          console.log(`⚠️ Agent initial msg was handoff for ${targetJid} - goal might be too vague or serious, using safe fallback instead of handoff`);
          const stripped = initialMsg.replace('__HANDOFF__', '').split('__REASON__')[0].trim();
          // For proactive agent messages, don't send handoff message (confusing) - use safe casual greeting instead
          const timeCtxFallback = getNigerianTimeContext();
          if (goal.toLowerCase().includes('maam') || goal.toLowerCase().includes("ma'am") || goal.toLowerCase().includes(' ma ') || goal.toLowerCase().includes('respect')) {
            initialMsg = `${timeCtxFallback.greeting} ma'am, how are you doing today? Hope you dey fine 🙂 Just checking in on your side.`;
          } else {
            initialMsg = `${timeCtxFallback.greeting}, how you dey? Hope you dey fine 🙂 Just checking in.`;
          }
          console.log(`🤖 Using safe fallback for agent: ${initialMsg}`);
        }
        
        if (agentShouldDisclose) {
          try { await memory.setLastDisclosure(targetJid); } catch {}
        }
      } catch (e) {
        console.error(`❌ Failed to generate initial msg for ${targetJid}:`, e.message);
        // Time-aware fallback
        const fallbackGreeting = timeCtx.greeting === 'Hello' ? 'Hello' : timeCtx.greeting;
        if (genderHint.includes('female')) {
          initialMsg = `${fallbackGreeting} ma, how you dey? Hope you dey fine? 🙏`;
        } else if (genderHint.includes('male')) {
          initialMsg = `${fallbackGreeting} Sir, how you dey? Hope you dey fine? 🙏`;
        } else if (goal.toLowerCase().includes('project')) {
          initialMsg = `${fallbackGreeting}, how far? How the project dey go? Any update? 🙏`;
        } else {
          initialMsg = `${fallbackGreeting}, how you dey? How body? Hope you dey fine? 🙏`;
        }
        if (goal.toLowerCase().includes('greet') || goal.toLowerCase().includes('how they are')) {
          if (genderHint.includes('female') && !initialMsg.toLowerCase().includes(' ma')) initialMsg = initialMsg.replace(fallbackGreeting, `${fallbackGreeting} ma,`);
          if (genderHint.includes('male') && !initialMsg.toLowerCase().includes('sir')) initialMsg = initialMsg.replace(fallbackGreeting, `${fallbackGreeting} Sir,`);
        }
        console.log(`🤖 Using fallback initial msg (${timeCtx.greeting}): ${initialMsg}`);
      }

      if (!initialMsg || initialMsg.includes('Network dey worry') || initialMsg.length < 3) {
        const fbGreet = timeCtx.greeting;
        if (genderHint.includes('female')) initialMsg = `${fbGreet} ma, how you dey? ${goal.slice(0,60)} 🙏`;
        else if (genderHint.includes('male')) initialMsg = `${fbGreet} Sir, how you dey? ${goal.slice(0,60)} 🙏`;
        else initialMsg = `${fbGreet}, how you dey? ${goal.slice(0,60)} 🙏`;
      }
      
      // Human-like timing for proactive agent message
      await delay(getSeenDelay());
      await delay(getThinkingGap());
      await sock.sendPresenceUpdate('composing', targetJid);
      await delay(getTypingDuration(initialMsg));
      await sock.sendPresenceUpdate('paused', targetJid);
      
      console.log(`📤 Sending agent message to ${targetJid}: ${initialMsg.slice(0,100)}...`);
      try {
        await sock.sendMessage(targetJid, { text: initialMsg });
        console.log(`✅ Agent message SENT to ${targetJid}`);
        await memory.addMessage(targetJid, 'assistant', initialMsg);
        await agentManager.updateTask(targetJid, { 
          history: [{ role: 'assistant', content: initialMsg }],
          steps: 1
        });
        started++;
      } catch (sendErr) {
        console.error(`❌ Failed to SEND message to ${targetJid}:`, sendErr.message);
        try {
          console.log(`🔄 Retrying send to ${targetJid} after 2s...`);
          await delay(2000);
          await sock.sendMessage(targetJid, { text: initialMsg });
          console.log(`✅ Retry succeeded for ${targetJid}`);
          await memory.addMessage(targetJid, 'assistant', initialMsg);
          await agentManager.updateTask(targetJid, { history: [{ role: 'assistant', content: initialMsg }], steps: 1 });
          started++;
        } catch (retryErr) {
          console.error(`❌ Retry also failed for ${targetJid}:`, retryErr.message);
          await agentManager.failTask(targetJid, `Failed to send: ${retryErr.message}`);
          failed++;
        }
      }
      
      if (numbers.length > 1) {
        // Human-like gap between messaging different people - not mechanical
        const betweenDelay = getRandomInt(8000, 25000);
        console.log(`⏳ Human-like gap before next contact: ${betweenDelay}ms`);
        await delay(betweenDelay);
      }
      
    } catch (e) {
      console.error(`Agent failed for ${num}:`, e.message, e.stack?.slice(0,300));
      failed++;
      try { await agentManager.failTask(`${num}@s.whatsapp.net`, e.message); } catch {}
    }
  }
  
  try {
    await sock.sendMessage(ownerJid, { text: `🚀 *Agent Launched*\n\n✅ Started: ${started}\n❌ Failed: ${failed}\nNumbers: ${numbers.join(', ')}\n\nI will chat with them and report back when goal is achieved. Check /status\n\n💡 Now you can just talk naturally without /agent - e.g.:\n"Greet 0901... 0811... as ma/Sir"\nOr share contacts and say "greet them all"` });
  } catch {}
}

async function handleAgentReply(jid, messageContent, mediaInfo, task) {
  try {
    // Handle voice note transcription for agent replies too
    let actualContent = messageContent;
    let transcription = null;
    
    if (mediaInfo && (mediaInfo.type === 'voice' || mediaInfo.type === 'audio' || mediaInfo.type === 'video')) {
      try {
        // We need original msg to download - we don't have it here, so we try to use messageContent if it's transcription already
        // For agent flow, mediaInfo comes from extractContent, but buffer not available
        // We will try to handle if messageContent is [Voice note] - try to get buffer via global? 
        // For now, if mediaInfo has no transcription, we will attempt to download using last message
        // Simplification: If it's voice and messageContent is placeholder, we will note it and still generate reply
        // The main transcription happens in handleMessage before calling this, but for agent we need to handle msg object
        // Actually handleMessage for agent path doesn't download, so we need to handle transcription in handleMessage before
        // This is called from handleMessage which already has mediaInfo but not buffer
        // We'll attempt transcription if we can get buffer from msg - but we don't have msg here
        // So we will just use messageContent as is, but if it's placeholder, we add context
        if (messageContent && (messageContent.includes('[Voice') || messageContent.includes('[Audio') || messageContent.includes('[Video'))) {
          // Try to indicate it was voice
          actualContent = `${messageContent} (voice note - transcription not available in agent flow, respond naturally asking for clarification if needed)`;
        }
      } catch (e) {
        console.error(`Agent transcription error: ${e.message}`);
      }
    }
    
    const historyText = actualContent || (mediaInfo ? `[${mediaInfo.type}]` : '');
    await memory.addMessage(jid, 'user', historyText);
    
    task.history.push({ role: 'user', content: historyText });
    task.steps++;
    
    console.log(`🤖 Agent step ${task.steps} for ${jid}: ${historyText.slice(0,80)}...`);
    
    if (task.steps >= task.maxSteps) {
      await agentManager.completeTask(jid, `Max steps (${task.maxSteps}) reached. Last message: ${historyText}`);
      return;
    }
    
    const history = await memory.getHistory(jid);
    const ownerStyle = await memory.getOwnerStyle(jid);
    const styleTexts = ownerStyle.map(s => s.content);
    
    const timeCtxReply = getNigerianTimeContext();
    const goalPrompt = `You are in an AGENT TASK. Your goal: ${task.goal}. You are chatting with ${jid.split('@')[0]}. Continue conversation to achieve goal. Current step ${task.steps}/${task.maxSteps}. You are ${config.assistantName}, ${config.ownerName}'s AI assistant (never claim to be ${config.ownerName}). Keep it natural and short. If goal achieved, say so naturally and wrap up. TIME: ${timeCtxReply.formatted} - Use time-appropriate greeting if greeting needed.`;
    
    const fullHistory = [...history.slice(0, -1), { role: 'system', content: goalPrompt }];
    
    // Human-like timing for agent too - seen delay before processing
    const agentSeenDelay = getSeenDelay();
    await delay(agentSeenDelay);
    
    let mediaForAI = null;
    if (transcription) {
      mediaForAI = { type: 'voice', transcription, mimeType: 'audio/ogg' };
    }
    
    const aiReply = await generateReply(jid, actualContent || historyText, fullHistory, styleTexts, mediaForAI, {});
    
    // Human-like typing for agent - duration matches length
    await delay(getThinkingGap());
    await sock.sendPresenceUpdate('composing', jid);
    await delay(getTypingDuration(aiReply.startsWith('__HANDOFF__') ? aiReply.replace('__HANDOFF__', '').split('__REASON__')[0].trim() : aiReply));
    
    // Handle handoff in agent flow too
    if (aiReply.startsWith('__HANDOFF__')) {
      const handoffMsg = aiReply.replace('__HANDOFF__', '').split('__REASON__')[0].trim();
      await sock.sendMessage(jid, { text: handoffMsg });
      await memory.addMessage(jid, 'assistant', handoffMsg);
      await memory.clearLastDisclosure(jid); // Next reply should disclose after handoff
      console.log(`⚠️ Agent handoff for ${jid}`);
      try {
        const ownerJid = `${config.phoneNumber}@s.whatsapp.net`;
        await sock.sendMessage(ownerJid, { text: `⚠️ Agent Handoff: ${jid.split('@')[0]} - ${actualContent?.slice(0,100)}` });
      } catch {}
      return;
    }
    
    await sock.sendMessage(jid, { text: aiReply });
    console.log(`🤖 Agent replied to ${jid}: ${aiReply.slice(0,100)}...`);
    
    await memory.addMessage(jid, 'assistant', aiReply);
    task.history.push({ role: 'assistant', content: aiReply });
    
    await agentManager.updateTask(jid, { history: task.history, steps: task.steps });
    
    const achieved = await agentManager.isGoalAchieved(task.goal, task.history);
    if (achieved) {
      await agentManager.completeTask(jid, `Goal achieved: ${task.goal}`);
    }
    
    await sock.sendPresenceUpdate('paused', jid);
    
  } catch (err) {
    console.error(`Agent reply error for ${jid}:`, err);
  }
}

async function extractContent(msg) {
  const m = msg.message;
  if (!m) return { text: '', mediaInfo: null };
  if (m.conversation) return { text: m.conversation, mediaInfo: null };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, mediaInfo: null };
  if (m.imageMessage) return { text: m.imageMessage.caption || '[Image]', mediaInfo: { type: 'image', caption: m.imageMessage.caption || '', mimeType: m.imageMessage.mimetype || 'image/jpeg' } };
  if (m.stickerMessage) return { text: '[Sticker]' + (m.stickerMessage.isAnimated ? ' (animated)' : ''), mediaInfo: { type: 'sticker', mimeType: m.stickerMessage.mimetype || 'image/webp' } };
  if (m.videoMessage) return { text: m.videoMessage.caption || '[Video]', mediaInfo: { type: 'video', caption: m.videoMessage.caption || '', mimeType: m.videoMessage.mimetype || 'video/mp4' } };
  if (m.audioMessage) {
    const isVoice = m.audioMessage.ptt;
    return { text: isVoice ? '[Voice note]' : '[Audio]', mediaInfo: { type: isVoice ? 'voice' : 'audio', mimeType: m.audioMessage.mimetype || 'audio/ogg' } };
  }
  if (m.documentMessage) return { text: m.documentMessage.caption || `[Document: ${m.documentMessage.fileName || 'file'}]`, mediaInfo: { type: 'document', caption: m.documentMessage.caption || '', mimeType: m.documentMessage.mimetype, fileName: m.documentMessage.fileName } };
  if (m.buttonsResponseMessage?.selectedButtonId) return { text: m.buttonsResponseMessage.selectedButtonId, mediaInfo: null };
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) return { text: m.listResponseMessage.title || m.listResponseMessage.singleSelectReply.selectedRowId, mediaInfo: null };
  if (m.templateButtonReplyMessage?.selectedId) return { text: m.templateButtonReplyMessage.selectedId, mediaInfo: null };
  if (m.reactionMessage) {
    const emoji = m.reactionMessage.text || '❤️';
    return { text: `[Reacted ${emoji}]`, mediaInfo: { type: 'reaction', emoji } };
  }
  if (m.protocolMessage) return { text: '', mediaInfo: null };
  if (m.viewOnceMessageV2?.message) {
    const inner = m.viewOnceMessageV2.message;
    if (inner.imageMessage) return { text: inner.imageMessage.caption || '[View once image]', mediaInfo: { type: 'image', caption: inner.imageMessage.caption || '' } };
    if (inner.videoMessage) return { text: inner.videoMessage.caption || '[View once video]', mediaInfo: { type: 'video' } };
    if (inner.extendedTextMessage?.text) return { text: inner.extendedTextMessage.text, mediaInfo: null };
  }
  if (m.locationMessage) return { text: `[Location: ${m.locationMessage.degreesLatitude}, ${m.locationMessage.degreesLongitude}]`, mediaInfo: { type: 'location' } };
  if (m.contactMessage) {
    const vcard = m.contactMessage.vcard || '';
    const numbers = extractNumbersFromVcard(vcard);
    const displayName = m.contactMessage.displayName || 'Contact';
    console.log(`📇 Contact share: ${displayName} -> ${numbers.join(', ')}`);
    return { text: `[Contact: ${displayName}] ${numbers.join(', ')}`, mediaInfo: { type: 'contact', numbers, displayName, vcard } };
  }
  if (m.contactsArrayMessage) {
    const contacts = m.contactsArrayMessage.contacts || [];
    const allNumbers = [];
    const names = [];
    for (const c of contacts) {
      const vcard = c.vcard || '';
      const nums = extractNumbersFromVcard(vcard);
      allNumbers.push(...nums);
      names.push(c.displayName || 'Contact');
    }
    console.log(`📇 Multiple contacts share: ${names.join(', ')} -> ${allNumbers.join(', ')}`);
    return { text: `[Contacts: ${names.join(', ')}] ${allNumbers.join(', ')}`, mediaInfo: { type: 'contact', numbers: [...new Set(allNumbers)], displayNames: names } };
  }
  if (m.pollCreationMessage) return { text: `[Poll: ${m.pollCreationMessage.name}]`, mediaInfo: null };
  return { text: '', mediaInfo: null };
}

async function handleOwnerCommand(cmd, currentJid) {
  console.log(`👑 Owner command: ${JSON.stringify(cmd)} in ${currentJid}`);
  const sendTo = currentJid;
  switch (cmd.action) {
    case 'pause': {
      if (!cmd.target) { await sock.sendMessage(sendTo, { text: 'Usage: /pause 2348012345678' }); return; }
      const targetJid = `${cmd.target}@s.whatsapp.net`;
      await memory.setHandoff(targetJid, config.handoffMinutes);
      await sock.sendMessage(sendTo, { text: `⏸️ Paused for ${cmd.target}` });
      break;
    }
    case 'resume': {
      if (!cmd.target) { await sock.sendMessage(sendTo, { text: 'Usage: /resume 2348012345678 or /resume all' }); return; }
      const targetJid = `${cmd.target}@s.whatsapp.net`;
      await memory.clearHandoff(targetJid);
      await sock.sendMessage(sendTo, { text: `▶️ Resumed for ${cmd.target}` });
      break;
    }
    case 'resumeAll': {
      await memory.clearAllHandoffs();
      await sock.sendMessage(sendTo, { text: '▶️ Resumed for ALL' });
      break;
    }
    case 'clear': {
      if (!cmd.target) { await sock.sendMessage(sendTo, { text: 'Usage: /clear 2348012345678 or /clear sessions to fix Bad MAC' }); return; }
      const targetJid = `${cmd.target}@s.whatsapp.net`;
      await memory.clearHistory(targetJid);
      await sock.sendMessage(sendTo, { text: `🗑️ History cleared for ${cmd.target}` });
      break;
    }
    case 'clearSessions': {
      try {
        await sock.sendMessage(sendTo, { text: `🧹 Clearing Bad MAC sessions... This fixes "Failed to decrypt" errors. Bot will re-establish sessions on next messages.` });
        let cleared = 0;
        if (auth && auth.clearSessions) {
          cleared = await auth.clearSessions();
        } else {
          // Fallback: create temp auth
          const { createAuthState } = await import('./auth.js');
          const tempAuth = await createAuthState();
          if (tempAuth.clearSessions) cleared = await tempAuth.clearSessions();
        }
        await sock.sendMessage(sendTo, { text: `✅ Cleared ${cleared} session keys!\n\nBad MAC should be fixed now. Future messages will decrypt correctly. Old queued messages that failed to decrypt are lost, but new messages will work.\n\nIf still seeing Bad MAC, you may need to re-pair once.` });
      } catch (e) {
        await sock.sendMessage(sendTo, { text: `❌ Failed to clear sessions: ${e.message}\n\nTry the /clear-sessions web endpoint with your ADMIN_KEY.` });
      }
      break;
    }
    case 'send': {
      if (!cmd.target || !cmd.message) { await sock.sendMessage(sendTo, { text: 'Usage: /send 2348012345678 Your message here\n\nExamples:\n/send 08051934689 Hello boss how far?\n/send 0901 434 7620, 0811 003 3639 Hello everyone\n\n💡 Now you can also just say naturally:\n"Greet 0901 434 7620 0811 003 3639 as ma/Sir"' }); return; }
      let targets = extractNumbersRobust(cmd.target);
      if (targets.length === 0) {
        const { normalizeNumber } = await import('./agent.js');
        const single = normalizeNumber(cmd.target);
        if (single) targets = [single];
      }
      if (targets.length === 0) { await sock.sendMessage(sendTo, { text: `❌ Invalid number: ${cmd.target}` }); return; }
      
      let sent = 0, failed = 0;
      for (const normalized of targets) {
        const targetJid = `${normalized}@s.whatsapp.net`;
        try {
          console.log(`📤 Owner /send to ${targetJid}: ${cmd.message.slice(0,80)}...`);
          await sock.sendMessage(targetJid, { text: cmd.message });
          await memory.addMessage(targetJid, 'assistant', cmd.message);
          await memory.addOwnerMessage(targetJid, cmd.message);
          sent++;
          if (targets.length > 1) await delay(3000);
        } catch (e) {
          console.error(`❌ /send failed for ${targetJid}:`, e.message);
          failed++;
        }
      }
      await sock.sendMessage(sendTo, { text: `✅ Broadcast result: Sent ${sent}, Failed ${failed} to ${targets.join(', ')}\n\nMessage: ${cmd.message}` });
      break;
    }
    case 'style': {
      if (!cmd.target) { await sock.sendMessage(sendTo, { text: 'Usage: /style 2348012345678' }); return; }
      const targetJid = `${cmd.target}@s.whatsapp.net`;
      const samples = await memory.getOwnerStyle(targetJid);
      if (samples.length === 0) await sock.sendMessage(sendTo, { text: `No style learned yet for ${cmd.target}` });
      else {
        const preview = samples.slice(-10).map(s => `• ${s.content}`).join('\n');
        await sock.sendMessage(sendTo, { text: `🎭 Style for ${cmd.target} (${samples.length} samples):\n\n${preview}` });
      }
      break;
    }
    case 'status': {
      const uptime = Math.floor(process.uptime());
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      const styleCount = await memory.getAllOwnerStylesCount();
      const agentTasks = await agentManager.listActiveTasks();
      const recent = await agentManager.getRecentSharedContacts(`${config.phoneNumber}@s.whatsapp.net`);
      await sock.sendMessage(sendTo, { text: `📊 *Bot Status - SUPER AGENT MODE*\n\n• Status: ${global.botStatus}\n• Uptime: ${hours}h ${mins}m\n• Model: ${config.geminiModel}\n• Learned: ${styleCount} contacts\n• Active agent tasks: ${agentTasks.length}\n• Recent shared contacts: ${recent.length > 0 ? recent.join(', ') : 'none'}\n• Media: Images, Stickers, Voice, Video, Contacts ✅\n• AI Chain: ${[config.geminiApiKey?'Gemini':null, config.groqApiKey?'Groq':null, config.openrouterApiKey?'OpenRouter':null, config.cerebrasApiKey?'Cerebras':null, config.githubToken?'GitHub':null].filter(Boolean).join(' → ')}\n• Connected: ${sock?.user ? 'Yes' : 'No'}\n\n🧠 Natural language: ON - Just talk to yourself!\nExamples:\n"Greet 0901... 0811... as ma/Sir"\nShare contacts + "greet them all"\n"Do same to all contacts I shared"\n\nOld: /agent 234... | Goal: ...\n📚 Import: /import` });
      break;
    }
    case 'help': {
      await sock.sendMessage(sendTo, { text: getOwnerHelpText() + '\n\n🧠 SUPER AGENT - No slash needed!\nJust say in self-chat:\n"Greet 0901 434 7620, 0811... ask how they are, ma for female Sir for male"\nOr share contacts and say "greet them all"\n\nBot understands:\n• Numbers with spaces: 0901 434 7620\n• Contact cards (WhatsApp share)\n• "them", "all", "same thing" = recent contacts\n• Gender from your history (ma/Sir)\n\nOld still works:\n/agent 234... | Goal: your goal\n/send 234... message' });
      break;
    }
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function delayRandom() {
  const min = config.replyDelayMin;
  const max = config.replyDelayMax;
  return delay(Math.floor(Math.random() * (max - min + 1)) + min);
}

// ===== HUMAN-LIKE TIMING - REALISTIC VARIATION =====
function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getRandomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

// Realistic "seen but not yet responding" gap - like person glancing at phone before replying
// Weighted: 60% quick (2-6s), 25% medium (7-15s), 10% slow (16-35s), 5% very slow (40-90s) for natural variation
function getSeenDelay(isMedia = false) {
  if (config.fastReplies) return getRandomInt(300, isMedia ? 2500 : 1500);
  const rand = Math.random();
  let baseMin, baseMax;
  
  if (rand < 0.6) {
    // 60% - Quick glance, actively on phone
    baseMin = 2000;
    baseMax = 6000;
  } else if (rand < 0.85) {
    // 25% - Medium, a bit busy / not instantly looking
    baseMin = 7000;
    baseMax = 15000;
  } else if (rand < 0.95) {
    // 10% - Slow, doing something else
    baseMin = 16000;
    baseMax = 35000;
  } else {
    // 5% - Very slow, away from phone, realistic human pattern
    baseMin = 40000;
    baseMax = 90000;
  }
  
  // If media (image/voice/video), add extra time to "view" it
  if (isMedia) {
    baseMin += 2000;
    baseMax += 8000;
  }
  
  const delay = getRandomInt(baseMin, baseMax);
  console.log(`⏳ Human-like seen delay: ${delay}ms (${(delay/1000).toFixed(1)}s) - ${rand < 0.6 ? 'quick' : rand < 0.85 ? 'medium' : rand < 0.95 ? 'slow' : 'very slow'}`);
  return delay;
}

// Typing duration roughly matching message length - like real person typing on phone
// Short replies = quick, long replies = longer typing, with natural variation
function getTypingDuration(text) {
  if (config.fastReplies) return Math.min(3000, Math.max(600, Math.floor((text || '').length * 30)));
  if (!text) return getRandomInt(1000, 2500);
  
  const len = text.length;
  let min, max;
  
  if (len < 10) {
    // Very short: "ok", "lol", "yes" - quick tap
    min = 800;
    max = 1800;
  } else if (len < 30) {
    // Short: 1-5 words
    min = 1500;
    max = 3500;
  } else if (len < 60) {
    // Medium-short: 1 line
    min = 2500;
    max = 5500;
  } else if (len < 120) {
    // Medium: 1-2 lines
    min = 4000;
    max = 8000;
  } else if (len < 200) {
    // Long: 2-3 lines
    min = 6000;
    max = 12000;
  } else if (len < 350) {
    // Very long: paragraph
    min = 9000;
    max = 16000;
  } else {
    // Extra long: capped
    min = 12000;
    max = 20000;
  }
  
  // Add natural variation: ±20%
  const variation = getRandomFloat(0.8, 1.25);
  let duration = Math.floor(getRandomInt(min, max) * variation);
  
  // Occasionally add extra thinking pause (15% chance) - like person pausing mid-thought
  if (Math.random() < 0.15) {
    const extraPause = getRandomInt(1000, 4000);
    duration += extraPause;
    console.log(`💭 Extra thinking pause +${extraPause}ms`);
  }
  
  console.log(`⌨️ Typing duration for ${len} chars: ${duration}ms (${(duration/1000).toFixed(1)}s)`);
  return duration;
}

// Small thinking gap before typing starts (after seen delay, before typing indicator)
function getThinkingGap() {
  if (config.fastReplies) return getRandomInt(100, 500);
  // 0.5-2.5s gap like person thinking what to say
  return getRandomInt(500, 2500);
}


async function transcribeAudio(buffer, mimeType = 'audio/ogg') {
  // Try Groq Whisper first (free, fast, no card)
  if (config.groqApiKey) {
    try {
      console.log(`🎙️ Transcribing audio with Groq Whisper (${mimeType}, ${buffer.length} bytes)...`);
      const formData = new FormData();
      // Determine extension from mimeType
      let ext = 'ogg';
      if (mimeType.includes('mp4')) ext = 'mp4';
      else if (mimeType.includes('mpeg') || mimeType.includes('mp3')) ext = 'mp3';
      else if (mimeType.includes('wav')) ext = 'wav';
      else if (mimeType.includes('webm')) ext = 'webm';
      else if (mimeType.includes('ogg')) ext = 'ogg';
      
      const blob = new Blob([buffer], { type: mimeType });
      formData.append('file', blob, `audio.${ext}`);
      formData.append('model', 'whisper-large-v3-turbo');
      formData.append('response_format', 'json');
      // Auto-detect language, but hint for Nigerian English + pidgin
      // formData.append('language', 'en');
      
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.groqApiKey}`
        },
        body: formData
      });
      
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Groq Whisper ${res.status}: ${errText.slice(0,200)}`);
      }
      
      const data = await res.json();
      const text = data.text || data.transcription || '';
      if (text) {
        console.log(`✅ Groq Whisper transcribed: "${text.slice(0,100)}..."`);
        return text.trim();
      }
    } catch (e) {
      console.error(`❌ Groq Whisper failed: ${e.message.slice(0,300)}`);
    }
  }
  
  // Fallback: Try HuggingFace Whisper if available
  if (config.hfApiKey) {
    try {
      console.log(`🎙️ Trying HuggingFace Whisper...`);
      // HF inference API for whisper
      const res = await fetch(`https://api-inference.huggingface.co/models/openai/whisper-large-v3-turbo`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.hfApiKey}`,
          'Content-Type': mimeType
        },
        body: buffer
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.text || data.transcription || '';
        if (text) {
          console.log(`✅ HF Whisper: "${text.slice(0,100)}..."`);
          return text.trim();
        }
      }
    } catch (e) {
      console.error(`❌ HF Whisper failed: ${e.message.slice(0,200)}`);
    }
  }
  
  console.log(`⚠️ No transcription available, will handle as voice note without text`);
  return null;
}

process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down...');
  if (sock) await sock.end();
  server.close();
  process.exit(0);
});
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });

startBot();
