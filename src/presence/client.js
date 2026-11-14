'use strict';
// Presence client: after the owner exists, the Hub registers itself with the configured directory seeds (zero-config
// for users), sends tiny heartbeats and can resolve / search people. It never uploads or downloads content.
// Seed failures never block boot: everything runs in the background with short timeouts and exponential backoff.
const { validateEndpoint } = require('../federation/transport');
const { isAccountId } = require('../keystore');
const { buildRecord, buildHeartbeat, buildWithdraw, validateRecord, cleanName } = require('./record');
const { resolvePublicUrl } = require('../net/public-url');

const MAX_SEEDS = 5;

class PresenceClient {
  constructor({ db, ks, cfg, log, transport, self }) {
    Object.assign(this, { db, ks, cfg, log, transport, selfFn: self });
    this.states = new Map(); this.timer = null; this.first = null; this.stopped = false; this.running = false;
    this.cache = new Map(); this.lastAttempt = 0;
  }

  // ---------- settings (owner) ----------
  _get(k) { try { return this.db.get('SELECT value FROM meta WHERE key=?', k)?.value; } catch { return undefined; } }
  _set(k, v) { this.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', k, String(v)); }
  settings() {
    const b = (k, d) => { const v = this._get(k); return v === undefined ? d : v === '1'; };
    const region = this._get('presence_region');
    return { enabled: b('presence_enabled', this.cfg.presence.enabled), searchable: b('presence_searchable', true), share_endpoint: b('presence_share_endpoint', true), region: (region !== undefined ? region : this.cfg.presence.region) || '' };
  }
  setSettings(p = {}) {
    if (p.enabled !== undefined) this._set('presence_enabled', p.enabled ? '1' : '0');
    if (p.searchable !== undefined) this._set('presence_searchable', p.searchable ? '1' : '0');
    if (p.share_endpoint !== undefined) this._set('presence_share_endpoint', p.share_endpoint ? '1' : '0');
    if (p.region !== undefined) { const r = String(p.region || '').toUpperCase(); if (r && !/^[A-Z]{2}$/.test(r)) { const e = new Error('bad_region'); e.code = 'bad_region'; throw e; } this._set('presence_region', r); }
    const was = this.settings();
    if (p.enabled === false) this.withdraw().catch(() => {});
    this.states.forEach((st) => { st.fp = ''; st.next_at = 0; });   // force re-register with new settings
    this.kick();
    return was;
  }

  seeds() {
    const out = []; const seen = new Set();
    for (const raw of this.cfg.presence.seeds) {
      try { const url = validateEndpoint(raw, { allowPrivate: this.cfg.allowPrivatePeers }); if (!seen.has(url)) { seen.add(url); out.push({ id: 'seed-' + (out.length + 1), url }); } } catch { /* invalid seed ignored */ }
      if (out.length >= MAX_SEEDS) break;
    }
    return out;
  }

  // ---------- own record ----------
  _record(now = Date.now()) {
    const me = this.selfFn(); if (!me) return null;
    const st = this.settings(); let endpoint;
    if (st.share_endpoint) {
      const pub = resolvePublicUrl({ db: this.db, cfg: this.cfg }).url; // configured/override only — never derived from request headers
      if (pub) { try { endpoint = validateEndpoint(pub, { allowPrivate: this.cfg.allowPrivatePeers }); } catch { endpoint = undefined; } }
    }
    return buildRecord(this.ks, { account: me.account, endpoint, region: st.region, name: cleanName(me.name), searchable: st.searchable }, now);
  }
  _fingerprint() {
    const me = this.selfFn(); if (!me) return '';
    const st = this.settings();
    const pub = st.share_endpoint ? resolvePublicUrl({ db: this.db, cfg: this.cfg }).url : '';
    return JSON.stringify([me.account, cleanName(me.name), st.searchable, st.region, pub]);
  }

  // ---------- network ----------
  async _call(seed, method, path, body) {
    const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const res = await this.transport.request(seed.url, { method, path, headers: payload ? { 'Content-Type': 'application/json' } : {}, body: payload, timeoutMs: this.cfg.presence.timeoutMs }, 64 * 1024);
    let j = null; try { j = JSON.parse(res.body.toString('utf8')); } catch { /* not json */ }
    if (res.status >= 300) { const e = new Error((j && j.code) || 'http_' + res.status); e.code = (j && j.code) || 'http_' + res.status; e.status = res.status; throw e; }
    return j || {};
  }

  async _doSeed(seed, now = Date.now()) {
    const st = this.states.get(seed.id) || { ok: false, registered: false, fail_streak: 0, next_at: 0, last_ok: null, last_error: null, fp: '' };
    this.states.set(seed.id, st); st.attempted = true;
    try {
      const fp = this._fingerprint();
      if (st.registered && st.fp === fp) {
        try { await this._call(seed, 'POST', '/presence/v1/heartbeat', buildHeartbeat(this.ks, this.selfFn().account, Date.now())); }
        catch (e) { if (e.code === 'E_PRESENCE_UNKNOWN') { st.registered = false; } else throw e; }
      }
      if (!st.registered || st.fp !== fp) {
        await this._call(seed, 'POST', '/presence/v1/register', this._record(Date.now()));
        st.registered = true; st.fp = fp;
      }
      st.ok = true; st.fail_streak = 0; st.last_ok = Date.now(); st.last_error = null;
      st.next_at = Date.now() + Math.floor(this.cfg.presence.heartbeatMs * (0.9 + Math.random() * 0.2));
    } catch (e) {
      st.ok = false; st.fail_streak++; st.last_error = String(e.code || e.message).slice(0, 60);
      const delay = Math.min(900000, 10000 * 2 ** Math.min(st.fail_streak - 1, 7)) * (0.5 + Math.random() * 0.5);
      st.next_at = Date.now() + Math.min(delay, this.cfg.presence.heartbeatMs * 3);
      this.log.debug(`presence ${seed.id} failed: ${st.last_error}`);
    }
  }

  async tick(now = Date.now()) {
    if (this.running || this.stopped) return;
    const s = this.settings(); const me = this.selfFn();
    if (!s.enabled || !me || !this.cfg.federationEnabled) return;
    this.running = true;
    try {
      const due = this.seeds().filter((sd) => (this.states.get(sd.id)?.next_at || 0) <= now);
      this.lastAttempt = now;
      await Promise.allSettled(due.map((sd) => this._doSeed(sd, now)));
    } finally { this.running = false; }
  }

  start() {
    if (this.timer || this.stopped) return;
    // never in the boot path: first attempt is scheduled shortly after the server is already listening
    this.first = setTimeout(() => this.tick().catch(() => {}), 300 + Math.floor(Math.random() * 1500)); this.first.unref();
    this.timer = setInterval(() => this.tick().catch(() => {}), Math.max(200, Math.min(5000, this.cfg.presence.heartbeatMs))); this.timer.unref();
  }
  kick() { if (this.stopped) return; const t = setTimeout(() => this.tick().catch(() => {}), 50); t.unref(); }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); this.timer = this.first = null; }

  async withdraw() {
    const me = this.selfFn(); if (!me) return;
    for (const sd of this.seeds()) { try { await this._call(sd, 'POST', '/presence/v1/withdraw', buildWithdraw(this.ks, me.account, Date.now())); } catch { /* best effort */ } }
    this.states.clear();
  }

  // ---------- lookups (read-only, tiny) ----------
  _orderedSeeds() { return this.seeds().sort((a, b) => (this.states.get(b.id)?.ok ? 1 : 0) - (this.states.get(a.id)?.ok ? 1 : 0)); }
  async resolve(account, { fresh = false } = {}) {
    if (!isAccountId(account)) return null;
    const c = this.cache.get(account);
    if (!fresh && c && Date.now() - c.at < 300000) return c.val;
    let lastErr = null;
    for (const sd of this._orderedSeeds()) {
      try {
        const r = await this._call(sd, 'GET', '/presence/v1/resolve?account=' + encodeURIComponent(account));
        validateRecord(r.record, { checkTs: false, allowPrivate: this.cfg.allowPrivatePeers });   // signed by the account itself
        if (r.record.account_id !== account) throw Object.assign(new Error('mismatch'), { code: 'mismatch' });
        const val = { record: r.record, online: !!r.online, last_seen: Number(r.last_seen) || null };
        if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(account, { at: Date.now(), val });
        return val;
      } catch (e) { lastErr = e; if (e.code === 'E_PRESENCE_UNKNOWN') continue; }
    }
    if (lastErr && lastErr.code !== 'E_PRESENCE_UNKNOWN') throw lastErr;
    return null;
  }
  async search(q) {
    let lastErr = null;
    for (const sd of this._orderedSeeds()) {
      try { const r = await this._call(sd, 'GET', '/presence/v1/search?q=' + encodeURIComponent(String(q).slice(0, 40))); return (Array.isArray(r.items) ? r.items : []).filter((x) => x && isAccountId(x.account_id)).slice(0, 20).map((x) => ({ account_id: x.account_id, name: cleanName(x.name), region: /^[A-Z]{2}$/.test(x.region || '') ? x.region : null, online: !!x.online, last_seen: Number(x.last_seen) || null, reachable: !!x.reachable })); }
      catch (e) { lastErr = e; }
    }
    if (lastErr) throw lastErr;
    return [];
  }

  status() {
    const s = this.settings(); const me = this.selfFn(); const seeds = this.seeds();
    const sts = seeds.map((sd) => this.states.get(sd.id)).filter(Boolean);
    const ok = sts.filter((x) => x.ok).length;
    let state = 'local'; let reason = null;
    if (!s.enabled) reason = 'disabled'; else if (!me) reason = 'no_owner'; else if (!this.cfg.federationEnabled) reason = 'federation_off'; else if (!seeds.length) reason = 'no_seed';
    else if (ok > 0) state = 'network'; else if (!sts.some((x) => x.attempted)) { state = 'connecting'; reason = 'starting'; } else { state = 'error'; reason = 'seed_unreachable'; }
    return {
      enabled: s.enabled, state, reason, listed: sts.some((x) => x.registered && x.ok), searchable: s.searchable, share_endpoint: s.share_endpoint, region: s.region || null,
      seeds_total: seeds.length, seeds_ok: ok, last_ok: sts.reduce((m, x) => Math.max(m, x.last_ok || 0), 0) || null,
      last_error: ok ? null : (sts.map((x) => x.last_error).find(Boolean) || null),
      endpoint_known: !!resolvePublicUrl({ db: this.db, cfg: this.cfg }).url, serving: !!this.cfg.presence.serve,
      content_sync: this.contentMode ? this.contentMode() : 'off',
    };
  }
}
module.exports = { PresenceClient };
