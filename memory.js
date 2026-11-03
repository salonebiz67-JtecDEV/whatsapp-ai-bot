import { Redis } from '@upstash/redis';
import fs from 'fs';
import path from 'path';

class MemoryStore {
  constructor(redis) {
    this.redis = redis;
    this.isRedis = !!redis;
    this.localDir = './memory_store';
    if (!this.isRedis && !fs.existsSync(this.localDir)) {
      fs.mkdirSync(this.localDir, { recursive: true });
    }
    this.maxHistory = parseInt(process.env.MAX_HISTORY || '20', 10);
    this.maxOwnerSamples = 50; // how many of YOUR messages to remember per contact to learn style
  }

  _key(jid, suffix) {
    return `${suffix}:${jid}`;
  }

  _sanitize(jid) {
    return jid.replace(/[^a-zA-Z0-9]/g, '_');
  }

  // ---------- HISTORY (contact messages + bot replies) ----------
  async getHistory(jid) {
    const key = this._key(jid, 'chat:history');
    try {
      if (this.isRedis) {
        const data = await this.redis.get(key);
        if (!data) return [];
        return typeof data === 'string' ? JSON.parse(data) : data;
      } else {
        const file = path.join(this.localDir, `${this._sanitize(jid)}_history.json`);
        if (!fs.existsSync(file)) return [];
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      }
    } catch (e) {
      console.warn(`getHistory error for ${jid}:`, e.message);
      return [];
    }
  }

  async addMessage(jid, role, content) {
    if (!content) return;
    const key = this._key(jid, 'chat:history');
    try {
      let history = await this.getHistory(jid);
      history.push({ role, content, timestamp: Date.now() });
      if (history.length > this.maxHistory) {
        history = history.slice(-this.maxHistory);
      }
      if (this.isRedis) {
        await this.redis.set(key, JSON.stringify(history));
        await this.redis.expire(key, 60 * 60 * 24 * 30);
      } else {
        const file = path.join(this.localDir, `${this._sanitize(jid)}_history.json`);
        fs.writeFileSync(file, JSON.stringify(history, null, 2));
      }
    } catch (e) {
      console.warn(`addMessage error for ${jid}:`, e.message);
    }
  }

  async clearHistory(jid) {
    const key = this._key(jid, 'chat:history');
    try {
      if (this.isRedis) await this.redis.del(key);
      else {
        const file = path.join(this.localDir, `${this._sanitize(jid)}_history.json`);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    } catch {}
  }

  // ---------- OWNER STYLE LEARNING (YOUR messages per contact) ----------
  // This is the key to seamless mimicry - learns how YOU chat with EACH person uniquely
  async addOwnerMessage(jid, content) {
    if (!content || content.startsWith('/')) return; // ignore commands
    const key = this._key(jid, 'owner:style');
    try {
      let samples = await this.getOwnerStyle(jid);
      // Avoid duplicates
      if (samples.length > 0 && samples[samples.length - 1].content === content) return;
      
      samples.push({ content, timestamp: Date.now() });
      if (samples.length > this.maxOwnerSamples) {
        samples = samples.slice(-this.maxOwnerSamples);
      }
      if (this.isRedis) {
        await this.redis.set(key, JSON.stringify(samples));
        await this.redis.expire(key, 60 * 60 * 24 * 90); // keep 90 days
      } else {
        const file = path.join(this.localDir, `${this._sanitize(jid)}_owner_style.json`);
        fs.writeFileSync(file, JSON.stringify(samples, null, 2));
      }
      console.log(`📝 Learned owner style for ${jid}: "${content.slice(0,40)}..." (total ${samples.length} samples)`);
    } catch (e) {
      console.warn(`addOwnerMessage error:`, e.message);
    }
  }

  async getOwnerStyle(jid) {
    const key = this._key(jid, 'owner:style');
    try {
      if (this.isRedis) {
        const data = await this.redis.get(key);
        if (!data) return [];
        return typeof data === 'string' ? JSON.parse(data) : data;
      } else {
        const file = path.join(this.localDir, `${this._sanitize(jid)}_owner_style.json`);
        if (!fs.existsSync(file)) return [];
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      }
    } catch {
      return [];
    }
  }

  async getOwnerStylePrompt(jid) {
    const samples = await this.getOwnerStyle(jid);
    if (samples.length === 0) return null;
    
    // Take last 15 samples to build style prompt
    const recent = samples.slice(-15).map(s => s.content);
    return recent.join('\n');
  }

  async getAllOwnerStylesCount() {
    // For status command
    if (this.isRedis && typeof this.redis.keys === 'function') {
      try {
        const keys = await this.redis.keys('owner:style:*');
        return keys.length;
      } catch {}
    }
    return 0;
  }

  // ---------- RATE LIMIT ----------
  async isRateLimited(jid) {
    const maxPerHour = parseInt(process.env.MAX_PER_HOUR || '30', 10);
    const key = this._key(jid, 'ratelimit');
    try {
      if (this.isRedis) {
        const count = await this.redis.incr(key);
        if (count === 1) await this.redis.expire(key, 3600);
        return count > maxPerHour;
      } else {
        const file = path.join(this.localDir, `${this._sanitize(jid)}_ratelimit.json`);
        let data = { count: 0, resetAt: Date.now() + 3600000 };
        if (fs.existsSync(file)) {
          try {
            data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (Date.now() > data.resetAt) data = { count: 0, resetAt: Date.now() + 3600000 };
          } catch {}
        }
        data.count++;
        fs.writeFileSync(file, JSON.stringify(data));
        return data.count > maxPerHour;
      }
    } catch { return false; }
  }

  async getRateLimitCount(jid) {
    const key = this._key(jid, 'ratelimit');
    try {
      if (this.isRedis) {
        const count = await this.redis.get(key);
        return count ? parseInt(count, 10) : 0;
      }
    } catch {}
    return 0;
  }

  // ---------- HANDOFF ----------
  async isHandoff(jid) {
    const key = this._key(jid, 'handoff');
    try {
      if (this.isRedis) {
        const val = await this.redis.get(key);
        return !!val;
      } else {
        const file = path.join(this.localDir, `${this._sanitize(jid)}_handoff.json`);
        if (!fs.existsSync(file)) return false;
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (Date.now() > data.expiresAt) { fs.unlinkSync(file); return false; }
        return true;
      }
    } catch { return false; }
  }

  async setHandoff(jid, minutes = 120) {
    const key = this._key(jid, 'handoff');
    const ttlSeconds = minutes * 60;
    try {
      if (this.isRedis) await this.redis.set(key, '1', { ex: ttlSeconds });
      else {
        const file = path.join(this.localDir, `${this._sanitize(jid)}_handoff.json`);
        fs.writeFileSync(file, JSON.stringify({ expiresAt: Date.now() + ttlSeconds * 1000 }));
      }
      console.log(`⏸️ Handoff set for ${jid} for ${minutes} minutes`);
    } catch (e) { console.warn('setHandoff error:', e.message); }
  }

  async clearHandoff(jid) {
    const key = this._key(jid, 'handoff');
    try {
      if (this.isRedis) await this.redis.del(key);
      else {
        const file = path.join(this.localDir, `${this._sanitize(jid)}_handoff.json`);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      console.log(`▶️ Handoff cleared for ${jid}`);
    } catch {}
  }

  async clearAllHandoffs() {
    if (this.isRedis && typeof this.redis.keys === 'function') {
      try {
        const keys = await this.redis.keys('handoff:*');
        if (keys.length) await Promise.all(keys.map(k => this.redis.del(k)));
      } catch {}
    }
  }

  // ---------- OWNER TAKEOVER DETECTION ----------
  // When YOU (real owner) reply manually, bot should pause to avoid double-reply / interfering
  async setOwnerActive(jid) {
    const key = this._key(jid, 'owner:active');
    const now = Date.now();
    try {
      if (this.isRedis) {
        await this.redis.set(key, now.toString(), { ex: 60 * 60 * 24 }); // 24h expiry
      } else {
        const file = path.join(this.localDir, `${this._sanitize(jid)}_owner_active.json`);
        fs.writeFileSync(file, JSON.stringify({ timestamp: now }));
      }
      console.log(`👑 Owner active set for ${jid} at ${new Date(now).toISOString()}`);
      return now;
    } catch (e) {
      console.warn('setOwnerActive error:', e.message);
      return now;
    }
  }

  async getOwnerLastActive(jid) {
    const key = this._key(jid, 'owner:active');
    try {
      if (this.isRedis) {
        const val = await this.redis.get(key);
        if (!val) return null;
        return typeof val === 'string' ? parseInt(val, 10) : val;
      } else {
        const file = path.join(this.localDir, `${this._sanitize(jid)}_owner_active.json`);
        if (!fs.existsSync(file)) return null;
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return data.timestamp || null;
      }
    } catch {
      return null;
    }
  }

  async isOwnerRecentlyActive(jid, minutes = 10) {
    const last = await this.getOwnerLastActive(jid);
    if (!last) return false;
    const diffMins = (Date.now() - last) / 60000;
    return diffMins < minutes;
  }

  async clearOwnerActive(jid) {
    const key = this._key(jid, 'owner:active');
    try {
      if (this.isRedis) await this.redis.del(key);
      else {
        const file = path.join(this.localDir, `${this._sanitize(jid)}_owner_active.json`);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    } catch {}
  }

  // ---------- DISCLOSURE TRACKING ----------
  // Track when bot last disclosed it's an assistant to each contact
  async setLastDisclosure(jid) {
    const key = this._key(jid, 'disclosure:last');
    const now = Date.now();
    try {
      if (this.isRedis) {
        await this.redis.set(key, now.toString(), { ex: 60 * 60 * 24 * 30 }); // 30 days
      } else {
        const file = path.join(this.localDir, `${this._sanitize(jid)}_disclosure.json`);
        fs.writeFileSync(file, JSON.stringify({ timestamp: now }));
      }
      console.log(`📢 Disclosure tracked for ${jid} at ${new Date(now).toISOString()}`);
      return now;
    } catch (e) {
      console.warn('setLastDisclosure error:', e.message);
      return now;
    }
  }

  async getLastDisclosure(jid) {
    const key = this._key(jid, 'disclosure:last');
    try {
      if (this.isRedis) {
        const val = await this.redis.get(key);
        if (!val) return null;
        return typeof val === 'string' ? parseInt(val, 10) : val;
      } else {
        const file = path.join(this.localDir, `${this._sanitize(jid)}_disclosure.json`);
        if (!fs.existsSync(file)) return null;
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return data.timestamp || null;
      }
    } catch {
      return null;
    }
  }

  async shouldDisclose(jid) {
    const last = await this.getLastDisclosure(jid);
    if (!last) return true; // Never disclosed -> should disclose
    const twoWeeksMs = 14 * 24 * 60 * 60 * 1000;
    return Date.now() - last > twoWeeksMs; // More than 2 weeks since last disclosure
  }

  async clearLastDisclosure(jid) {
    const key = this._key(jid, 'disclosure:last');
    try {
      if (this.isRedis) await this.redis.del(key);
      else {
        const file = path.join(this.localDir, `${this._sanitize(jid)}_disclosure.json`);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      console.log(`🗑️ Disclosure cleared for ${jid} - next reply will disclose`);
    } catch {}
  }

  // ---------- GLOBAL OWNER ACTIVITY & AWAY MODE ----------
  async setGlobalOwnerActive() {
    const key = 'owner:global:active';
    const now = Date.now();
    try {
      if (this.isRedis) {
        await this.redis.set(key, now.toString(), { ex: 60 * 60 * 24 });
      } else {
        const file = path.join(this.localDir, `global_owner_active.json`);
        fs.writeFileSync(file, JSON.stringify({ timestamp: now }));
      }
      return now;
    } catch {
      return now;
    }
  }

  async getGlobalOwnerActive() {
    const key = 'owner:global:active';
    try {
      if (this.isRedis) {
        const val = await this.redis.get(key);
        if (!val) return null;
        return typeof val === 'string' ? parseInt(val, 10) : val;
      } else {
        const file = path.join(this.localDir, `global_owner_active.json`);
        if (!fs.existsSync(file)) return null;
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return data.timestamp || null;
      }
    } catch {
      return null;
    }
  }

  async isGlobalOwnerRecentlyActive(minutes = 10) {
    const last = await this.getGlobalOwnerActive();
    if (!last) return false;
    return (Date.now() - last) / 60000 < minutes;
  }

  async setGlobalAwayMode(isAway) {
    const key = 'owner:global:away';
    try {
      if (this.isRedis) {
        await this.redis.set(key, isAway ? '1' : '0', { ex: 60 * 60 * 24 * 7 }); // 7 days
      } else {
        const file = path.join(this.localDir, `global_away.json`);
        fs.writeFileSync(file, JSON.stringify({ isAway, timestamp: Date.now() }));
      }
      console.log(`🌙 Global away mode set to: ${isAway ? 'AWAY (bot active)' : 'BACK (bot quiet)'}`);
      return isAway;
    } catch (e) {
      console.warn('setGlobalAwayMode error:', e.message);
      return isAway;
    }
  }

  async getGlobalAwayMode() {
    const key = 'owner:global:away';
    try {
      if (this.isRedis) {
        const val = await this.redis.get(key);
        if (val === null || val === undefined) return null; // Not set, use per-chat logic
        return val === '1' || val === 1 || val === true;
      } else {
        const file = path.join(this.localDir, `global_away.json`);
        if (!fs.existsSync(file)) return null;
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return data.isAway;
      }
    } catch {
      return null;
    }
  }

  // ---------- PER-CONTACT PROFILE (relationship + your own instructions) + BOT ON/OFF SWITCH ----------
  async getContactProfile(jid) {
    try {
      if (this.isRedis) {
        const raw = await this.redis.hget('contacts:profile', jid);
        return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      }
      const file = path.join(this.localDir, 'contacts_profile.json');
      const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
      return all[jid] || null;
    } catch (e) { console.warn('getContactProfile error:', e.message); return null; }
  }

  async setContactProfile(jid, profile) {
    try {
      const clean = { relationship: profile.relationship || '', prompt: (profile.prompt || '').slice(0, 1200), updated: Date.now() };
      if (this.isRedis) {
        await this.redis.hset('contacts:profile', { [jid]: JSON.stringify(clean) });
      } else {
        const file = path.join(this.localDir, 'contacts_profile.json');
        const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
        all[jid] = clean;
        fs.writeFileSync(file, JSON.stringify(all));
      }
      return clean;
    } catch (e) { console.warn('setContactProfile error:', e.message); throw e; }
  }

  async listContactProfiles() {
    try {
      let obj = {};
      if (this.isRedis) obj = (await this.redis.hgetall('contacts:profile')) || {};
      else {
        const file = path.join(this.localDir, 'contacts_profile.json');
        obj = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
      }
      const out = {};
      for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'string' ? JSON.parse(v) : v;
      return out;
    } catch (e) { console.warn('listContactProfiles error:', e.message); return {}; }
  }

  async getBotPaused() {
    try {
      if (this.isRedis) return String(await this.redis.get('bot:paused')) === '1';
      return fs.existsSync(path.join(this.localDir, 'bot_paused'));
    } catch { return false; }
  }

  async setBotPaused(paused) {
    try {
      if (this.isRedis) { if (paused) await this.redis.set('bot:paused', '1'); else await this.redis.del('bot:paused'); }
      else {
        const f = path.join(this.localDir, 'bot_paused');
        if (paused) fs.writeFileSync(f, '1'); else if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    } catch (e) { console.warn('setBotPaused error:', e.message); }
  }

  // ---------- CONTACT INDEX + CHAT LOG (powers the dashboard Chats tab) ----------
  async touchContact(jid, patch) {
    try {
      let cur = null;
      const file = path.join(this.localDir, 'contacts_index.json');
      let all = {};
      if (this.isRedis) {
        const raw = await this.redis.hget('contacts:index', jid);
        cur = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      } else {
        all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
        cur = all[jid] || null;
      }
      const next = {
        jid,
        name: patch.name || (cur && cur.name) || null,
        last: patch.last != null ? patch.last : (cur && cur.last) || '',
        role: patch.role || (cur && cur.role) || 'contact',
        ts: patch.ts || Date.now(),
        count: ((cur && cur.count) || 0) + 1
      };
      if (this.isRedis) await this.redis.hset('contacts:index', { [jid]: JSON.stringify(next) });
      else { all[jid] = next; fs.writeFileSync(file, JSON.stringify(all)); }
    } catch (e) { console.warn('touchContact error:', e.message); }
  }

  async listContacts() {
    try {
      let obj = {};
      if (this.isRedis) obj = (await this.redis.hgetall('contacts:index')) || {};
      else {
        const file = path.join(this.localDir, 'contacts_index.json');
        obj = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
      }
      return Object.values(obj).map(v => (typeof v === 'string' ? JSON.parse(v) : v)).filter(Boolean).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    } catch (e) { console.warn('listContacts error:', e.message); return []; }
  }

  async addChatLog(jid, entry) {
    const key = `chatlog:${jid}`;
    try {
      if (this.isRedis) {
        await this.redis.rpush(key, JSON.stringify(entry));
        await this.redis.ltrim(key, -100, -1);
        await this.redis.expire(key, 60 * 60 * 24 * 30);
      } else {
        const file = path.join(this.localDir, `chatlog_${this._sanitize(jid)}.json`);
        const arr = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : [];
        arr.push(entry);
        fs.writeFileSync(file, JSON.stringify(arr.slice(-100)));
      }
    } catch (e) { console.warn('addChatLog error:', e.message); }
  }

  async getChatLog(jid) {
    const key = `chatlog:${jid}`;
    try {
      if (this.isRedis) {
        const items = await this.redis.lrange(key, 0, -1);
        return (items || []).map(i => (typeof i === 'string' ? JSON.parse(i) : i)).filter(Boolean);
      }
      const file = path.join(this.localDir, `chatlog_${this._sanitize(jid)}.json`);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : [];
    } catch (e) { console.warn('getChatLog error:', e.message); return []; }
  }

  // ---------- DAILY ACTIVITY LOG (used by the nightly summary) ----------
  async addActivity(dateKey, entry) {
    const key = `activity:${dateKey}`;
    try {
      const str = JSON.stringify(entry);
      if (this.isRedis) {
        await this.redis.rpush(key, str);
        await this.redis.expire(key, 60 * 60 * 24 * 4);
      } else {
        const file = path.join(this.localDir, `activity_${dateKey}.json`);
        const arr = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : [];
        arr.push(entry);
        fs.writeFileSync(file, JSON.stringify(arr.slice(-1000)));
      }
    } catch (e) {
      console.warn('addActivity error:', e.message);
    }
  }

  async getActivity(dateKey) {
    const key = `activity:${dateKey}`;
    try {
      if (this.isRedis) {
        const items = await this.redis.lrange(key, 0, 999);
        return (items || []).map(i => (typeof i === 'string' ? JSON.parse(i) : i)).filter(Boolean);
      }
      const file = path.join(this.localDir, `activity_${dateKey}.json`);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : [];
    } catch (e) {
      console.warn('getActivity error:', e.message);
      return [];
    }
  }

  async isSummarySent(dateKey) {
    const key = `summary:sent:${dateKey}`;
    try {
      if (this.isRedis) return !!(await this.redis.get(key));
      return fs.existsSync(path.join(this.localDir, `summary_sent_${dateKey}`));
    } catch { return false; }
  }

  async markSummarySent(dateKey) {
    const key = `summary:sent:${dateKey}`;
    try {
      if (this.isRedis) await this.redis.set(key, '1', { ex: 60 * 60 * 24 * 3 });
      else fs.writeFileSync(path.join(this.localDir, `summary_sent_${dateKey}`), '1');
    } catch {}
  }
}

let memoryInstance = null;
export async function getMemoryStore() {
  if (memoryInstance) return memoryInstance;
  const hasRedis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN;
  let redis = null;
  if (hasRedis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('🧠 Using Upstash Redis for conversation memory + owner style learning');
  } else {
    console.log('🧠 Using local file memory (will NOT survive Render restarts)');
  }
  memoryInstance = new MemoryStore(redis);
  return memoryInstance;
}
