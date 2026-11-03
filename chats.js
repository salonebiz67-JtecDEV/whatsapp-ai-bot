import { getMemoryStore } from './memory.js';

// Records every message into the dashboard's Chats tab (contact list + conversation log).
// role: 'contact' (they wrote), 'bot' (Johnny Tech replied), 'owner' (you replied yourself on your phone)
export async function trackChat(jid, { name = null, role, text, ts }) {
  try {
    if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return;
    const t = (text || '').toString().slice(0, 1000);
    if (!t) return;
    const when = ts && ts > 0 ? ts : Date.now();
    const saved = global.contactNames && global.contactNames.get(jid);
    const mem = await getMemoryStore();
    await Promise.all([
      mem.addChatLog(jid, { role, text: t, ts: when }),
      mem.touchContact(jid, { name: saved || name || null, last: t.slice(0, 140), role, ts: when })
    ]);
  } catch (e) {
    console.warn('trackChat failed:', e.message);
  }
}
