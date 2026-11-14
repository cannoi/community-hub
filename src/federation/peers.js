'use strict';
// Peer registry, handshake, pull-based synchronisation with cursors, discovery, endpoint announcements,
// bounded retry (exponential backoff + jitter) and on-demand public media retrieval.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROTOCOL, verifyHello, signRequest } = require('./protocol');
const { validateEndpoint } = require('./transport');
const { resolvePublicUrl } = require('../net/public-url');
const { isAccountId } = require('../keystore');
const { sniff } = require('../media');

const STATES = ['bootstrap', 'trusted', 'discovered', 'blocked'];
function machineCodeOf(p) {
  if (p.account_id && /^hub1_/.test(p.account_id)) {
    const a = p.account_id.slice(5);
    return 'hub1_' + a.slice(0, 4) + '…' + a.slice(-4);
  }
  const ep = String(p.endpoint || '');
  let h = 0;
  for (let i = 0; i < ep.length; i++) h = ((h << 5) - h + ep.charCodeAt(i)) | 0;
  return 'mc_' + Math.abs(h).toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
}


class PeerManager {
  constructor({ db, ledger, ks, cfg, log, transport, media, bus }) {
    Object.assign(this, { db, ledger, ks, cfg, log, transport, media, bus });
    this.inflight = new Set(); this.timer = null; this.running = false; this.stopped = false;
    this.mediaJobs = new Map(); this.lastPoke = new Map(); this.pokeTimer = null;
  }

  // ---------- self ----------
  self() {
    const u = this.db.get('SELECT account_id, display_name, username FROM users WHERE is_primary=1 AND account_id IS NOT NULL');
    if (!u) return null;
    const pub = resolvePublicUrl({ db: this.db, cfg: this.cfg });
    return { account: u.account_id, name: u.display_name || u.username, endpoint: pub.url || '' };
  }
  get enabled() { return this.cfg.federationEnabled && !!this.self(); }

  // ---------- registry ----------
  list() { return this.db.all('SELECT * FROM peers ORDER BY id'); }
  get(id) { return this.db.get('SELECT * FROM peers WHERE id=?', id); }
  byAccount(a) { return this.db.get('SELECT * FROM peers WHERE account_id=?', a); }
  /** Parse "hub1_xxx@https://host" or plain URL. */
  parseSpec(spec) {
    const m = /^(hub1_[a-z2-7]{52})@(.+)$/.exec(spec.trim());
    return m ? { pin: m[1], url: m[2] } : { pin: null, url: spec.trim() };
  }
  add(spec, { state = 'trusted', name = null } = {}) {
    const { pin, url } = this.parseSpec(spec);
    const endpoint = validateEndpoint(url, { allowPrivate: this.cfg.allowPrivatePeers });
    if (!STATES.includes(state)) throw Object.assign(new Error('bad_state'), { code: 'bad_state' });
    const self = this.self(); if (self && self.endpoint && new URL(self.endpoint).origin === endpoint) throw Object.assign(new Error('self'), { code: 'self' });
    const ex = this.db.get('SELECT * FROM peers WHERE endpoint=?', endpoint);
    if (ex) { if (state !== 'discovered' && ex.state === 'discovered') this.db.run('UPDATE peers SET state=? WHERE id=?', state, ex.id); return this.get(ex.id); }
    if (this.db.get('SELECT COUNT(*) c FROM peers').c >= this.cfg.maxPeers) throw Object.assign(new Error('too_many_peers'), { code: 'too_many_peers' });
    if (pin && !isAccountId(pin)) throw Object.assign(new Error('bad_pin'), { code: 'bad_pin' });
    // an explicitly blocked account id is recorded immediately so it is refused even before any handshake
    const sc = this.contentMode() === 'trusted' && (state === 'trusted' || state === 'bootstrap') ? 1 : 0;
    const r = this.db.run('INSERT INTO peers(account_id,endpoint,pin,state,name,created_at,sync_content) VALUES(?,?,?,?,?,?,?)', state === 'blocked' && pin ? pin : null, endpoint, pin, state, name, Date.now(), sc);
    return this.get(Number(r.lastInsertRowid));
  }

  // ---------- Global Presence, Local Content: content sync is opt-in ----------
  _meta(k) { try { return this.db.get('SELECT value FROM meta WHERE key=?', k)?.value; } catch { return undefined; } }
  /** 'off' (default): no bulk pull/push of posts, media or timelines with anyone. 'trusted': only peers flagged sync_content. */
  contentMode() { const v = this._meta('content_sync'); return v === 'trusted' || v === 'off' ? v : this.cfg.contentSync; }
  syncAllowed(p) { return !!p && p.state !== 'blocked' && this.contentMode() === 'trusted' && !!p.sync_content; }
  setContentMode(mode) {
    if (mode !== 'off' && mode !== 'trusted') throw Object.assign(new Error('bad_mode'), { code: 'bad_mode' });
    this.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES('content_sync',?)", mode);
    if (mode === 'trusted') this.db.run("UPDATE peers SET sync_content=1, next_retry_at=0 WHERE state IN ('trusted','bootstrap') AND sync_content=0");
    return mode;
  }
  setPeerSync(id, on) { this.db.run('UPDATE peers SET sync_content=?, next_retry_at=0 WHERE id=?', on ? 1 : 0, id); return this.get(id); }
  /** Same identity announced at a new endpoint: the candidate inherits trust + content-sync flag so the next link check can merge it. */
  addEndpointCandidate(row, url) {
    const p = this.add(`${row.account_id}@${url}`, { state: row.state === 'blocked' ? 'discovered' : row.state });
    if (p && row.state !== 'blocked' && p.id !== row.id) this.db.run('UPDATE peers SET sync_content=? WHERE id=?', row.sync_content ? 1 : 0, p.id);
    return p;
  }
  /** A "contact" = someone found through the directory and opened on demand. Never synced, bounded, pruned LRU. */
  addContact(account, endpoint, name = null) {
    if (!isAccountId(account)) throw Object.assign(new Error('bad_account'), { code: 'bad_account' });
    const ep = validateEndpoint(endpoint, { allowPrivate: this.cfg.allowPrivatePeers });
    const self = this.self(); if (self && self.account === account) return null;
    const ex = this.byAccount(account);
    if (ex) {
      if (ex.state !== 'blocked' && ex.state === 'discovered' && !ex.sync_content && ex.endpoint !== ep && !this.db.get('SELECT 1 x FROM peers WHERE endpoint=?', ep)) this.db.run('UPDATE peers SET endpoint=? WHERE id=?', ep, ex.id);
      return this.get(ex.id);
    }
    const byEp = this.db.get('SELECT * FROM peers WHERE endpoint=?', ep);
    if (byEp) { if (!byEp.account_id) this.db.run('UPDATE peers SET account_id=?, pin=COALESCE(pin,?) WHERE id=?', account, account, byEp.id); return this.get(byEp.id); }
    while (this.db.get('SELECT COUNT(*) c FROM peers').c >= this.cfg.maxPeers) {
      const old = this.db.get("SELECT id FROM peers WHERE state='discovered' AND sync_content=0 ORDER BY COALESCE(last_ok,created_at) ASC LIMIT 1");
      if (!old) throw Object.assign(new Error('too_many_peers'), { code: 'too_many_peers' });
      this.db.run('DELETE FROM peers WHERE id=?', old.id);
    }
    const r = this.db.run("INSERT INTO peers(account_id,endpoint,pin,state,name,created_at,sync_content) VALUES(?,?,?,'discovered',?,?,0)", account, ep, account, name, Date.now());
    return this.get(Number(r.lastInsertRowid));
  }
  setState(id, state) { if (!STATES.includes(state)) throw new Error('bad_state'); this.db.run('UPDATE peers SET state=? WHERE id=?', state, id); return this.get(id); }
  remove(id) { this.db.run('DELETE FROM peers WHERE id=?', id); }
  health(p, now = Date.now()) {
    if (p.state === 'blocked') return 'blocked';
    if (!p.last_ok) return p.fail_streak > 0 ? 'offline' : 'pending';
    if (p.fail_streak === 0) return 'healthy';
    return p.fail_streak < 3 ? 'degraded' : 'offline';
  }
  bootstrap() {
    for (const spec of this.cfg.bootstrapPeers) {
      try { this.add(spec, { state: 'bootstrap' }); } catch (e) { this.log.warn(`Ignoring bootstrap peer "${spec.slice(0, 80)}": ${e.code || e.message}`); }
    }
  }

  // ---------- requests ----------
  async call(peer, method, pathQuery, { body, maxBytes } = {}) {
    const self = this.self();
    const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const headers = signRequest(this.ks, self.account, { method, pathQuery, body: payload, aud: peer.account_id, endpoint: self.endpoint || undefined });
    if (payload) headers['Content-Type'] = 'application/json';
    const res = await this.transport.request(peer.endpoint, { method, path: pathQuery, headers, body: payload }, maxBytes);
    if (res.status >= 300) { const e = new Error('http_' + res.status); e.code = 'http_' + res.status; e.status = res.status; throw e; }
    try { return JSON.parse(res.body.toString('utf8')); } catch { throw Object.assign(new Error('bad_json'), { code: 'bad_json' }); }
  }

  async handshake(peer) {
    const self = this.self();
    const nonce = crypto.randomBytes(16).toString('base64url');
    const res = await this.transport.request(peer.endpoint, { method: 'GET', path: `/federation/v1/hello?nonce=${nonce}` }, 64 * 1024);
    if (res.status !== 200) throw Object.assign(new Error('http_' + res.status), { code: 'hello_http_' + res.status });
    let j; try { j = JSON.parse(res.body.toString('utf8')); } catch { throw Object.assign(new Error('bad_json'), { code: 'bad_json' }); }
    let info;
    try { info = verifyHello(j, { nonce, expectEndpoint: peer.endpoint, pin: peer.pin, knownAccount: peer.account_id, self: self.account }); } catch (e) {
      // The peer (proving its key) says it now lives elsewhere: remember the new endpoint as a candidate; it is verified by its own hello.
      if (e.moved && (peer.account_id === e.account || peer.pin === e.account)) { try { this.addEndpointCandidate(peer, e.moved); } catch { /* invalid/full */ } }
      throw e;
    }
    const other = this.byAccount(info.account);
    if (other && other.id !== peer.id) { // same identity reachable at a new endpoint: keep one row, carry the cursor
      const state = other.state === 'blocked' ? 'blocked' : (peer.state === 'discovered' ? other.state : peer.state);
      this.db.tx(() => {
        this.db.run('DELETE FROM peers WHERE id=?', peer.id);
        this.db.run('UPDATE peers SET endpoint=?, state=?, pubkey=?, fail_streak=0, next_retry_at=0 WHERE id=?', peer.endpoint, state, info.pub, other.id);
      });
      peer = this.get(other.id);
    } else this.db.run('UPDATE peers SET account_id=?, pubkey=?, name=COALESCE(?,name) WHERE id=?', info.account, info.pub, info.name, peer.id);
    return this.get(peer.id);
  }

  _fail(peer, e, now = Date.now()) {
    const streak = peer.fail_streak + 1;
    const delay = Math.min(this.cfg.backoffMaxMs, this.cfg.backoffBaseMs * 2 ** (streak - 1)) * (0.5 + Math.random() * 0.5);
    this.db.run('UPDATE peers SET fail_streak=?, error_count=error_count+1, last_error=?, next_retry_at=? WHERE id=?', streak, String(e.code || e.message).slice(0, 120), Math.floor(now + delay), peer.id);
    this.log.debug(`peer ${peer.endpoint} failed: ${e.code || e.message}; retry in ${Math.round(delay)}ms`);
  }

  /** One synchronisation cycle with one peer. Never throws. */
  async syncPeer(peerIn) {
    if (!this.enabled || this.inflight.has(peerIn.id) || this.stopped) return { skipped: true };
    this.inflight.add(peerIn.id);
    let peer = this.get(peerIn.id); if (!peer) { this.inflight.delete(peerIn.id); return { skipped: true }; }
    const stats = { accepted: 0, rejected: 0, duplicate: 0, gaps: 0, batches: 0 };
    try {
      peer = await this.handshake(peer);
      if (!this.syncAllowed(peer)) { // trusted link check only — no posts, media or timelines are transferred
        const t = Date.now();
        this.db.run('UPDATE peers SET last_ok=?, last_seen=?, last_error=NULL, fail_streak=0, next_retry_at=? WHERE id=?', t, t, t + Math.max(this.cfg.syncIntervalMs * 10, 300000), peer.id);
        return { ok: true, handshake_only: true, ...stats };
      }
      let cursor = peer.remote_cursor;
      for (let i = 0; i < this.cfg.syncMaxBatchesPerCycle; i++) {
        const r = await this.call(peer, 'GET', `/federation/v1/events?cursor=${cursor}&limit=${this.cfg.syncBatch}`, { maxBytes: 8 * 1024 * 1024 });
        if (!Array.isArray(r.events) || r.events.length > 200) throw Object.assign(new Error('bad_batch'), { code: 'bad_batch' });
        if (Number.isSafeInteger(r.head) && cursor > r.head) { cursor = 0; this.db.run('UPDATE peers SET remote_cursor=0 WHERE id=?', peer.id); this.log.warn('peer cursor ahead of peer head; restarting from 0'); continue; }
        const batch = this.ledger.ingestBatch(r.events.map((x) => x.event), { source: 'peer:' + peer.account_id });
        stats.batches++;
        const gapActors = new Map(); let rej = 0;
        batch.results.forEach((x) => {
          if (x.status === 'accepted') stats.accepted++; else if (x.status === 'duplicate') stats.duplicate++; else if (x.status === 'gap') { stats.gaps++; gapActors.set(x.actor_id, x.expected); } else { stats.rejected++; rej++; }
        });
        for (const [actor, expected] of gapActors) {
          try { await this.fillGap(peer, actor, expected, stats); } catch (e) { this.log.debug('gap fill failed: ' + (e.code || e.message)); }
        }
        const next = Number(r.next_cursor);
        if (!Number.isSafeInteger(next) || next < cursor) throw Object.assign(new Error('bad_cursor'), { code: 'bad_cursor' });
        cursor = next;
        this.db.run('UPDATE peers SET remote_cursor=?, events_received=events_received+?, events_rejected=events_rejected+? WHERE id=?', cursor, batch.summary.accepted || 0, rej, peer.id);
        if (!r.has_more) break;
      }
      const now = Date.now();
      this.db.run('UPDATE peers SET last_ok=?, last_seen=?, last_sync_at=?, last_error=NULL, fail_streak=0, next_retry_at=? WHERE id=?', now, now, now, now + this.cfg.syncIntervalMs, peer.id);
      this.afterSync(peer).catch((e) => this.log.debug('afterSync: ' + (e.code || e.message)));
      if (stats.accepted) this.bus.emit('synced', stats);
      return { ok: true, ...stats };
    } catch (e) {
      this._fail(this.get(peer.id) || peer, e);
      return { ok: false, error: e.code || e.message, ...stats };
    } finally { this.inflight.delete(peerIn.id); }
  }

  async fillGap(peer, actor, expected, stats) {
    let from = expected;
    for (let page = 0; page < 10; page++) {
      const r = await this.call(peer, 'GET', `/federation/v1/events/actor/${actor}?from=${from}&limit=100`, { maxBytes: 4 * 1024 * 1024 });
      if (!Array.isArray(r.events) || !r.events.length) return;
      const b = this.ledger.ingestBatch(r.events, { source: 'peer:' + peer.account_id });
      stats.accepted += b.summary.accepted || 0;
      const st = this.ledger.actorState(actor);
      if (!st || st.last_seq < from || r.events.length < 100) return;
      from = st.last_seq + 1;
    }
  }

  /** After a good sync: discovery from trusted peers and endpoint-announcement follow-up. */

  /** Announce ourselves to a peer that can reach us (or that we can reach). Best-effort. */
  async announceConnect(peer) {
    const self = this.self();
    if (!self || !self.endpoint) return null;
    try {
      return await this.call(peer, 'POST', '/federation/v1/connect', { body: { endpoint: self.endpoint, name: self.name } });
    } catch (e) {
      this.log.debug('connect announce failed: ' + (e.code || e.message));
      return null;
    }
  }

  /** Push recent public events to a peer that may not be able to pull us (NAT). */
  async pushInbox(peer, { limit = 50 } = {}) {
    const self = this.self();
    if (!self) return null;
    const metaKey = 'peer_push_cursor_' + peer.id;
    let cursor = 0;
    try { cursor = Number(this.db.get('SELECT value FROM meta WHERE key=?', metaKey)?.value) || 0; } catch { cursor = 0; }
    const events = this.ledger.publicEventsAfter(cursor, limit);
    if (!events || !events.length) return { ok: true, sent: 0 };
    try {
      const r = await this.call(peer, 'POST', '/federation/v1/inbox', { body: { events } });
      // advance using local lid of last pushed event
      const after = this.ledger.eventsAfter(cursor, events.length);
      const next = after.length ? after[after.length - 1].lid : cursor;
      try { this.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", metaKey, String(next)); } catch { /* ok */ }
      return { ok: true, sent: events.length, remote: r };
    } catch (e) {
      this.log.debug('inbox push failed: ' + (e.code || e.message));
      return { ok: false, error: e.code || e.message };
    }
  }

  async afterSync(peer) {
    const fresh = this.get(peer.id);
    // Mutual registration so the peer stores our endpoint when we are publicly reachable
    if (['bootstrap', 'trusted', 'discovered'].includes(fresh.state)) {
      await this.announceConnect(fresh);
    }
    if (['bootstrap', 'trusted'].includes(fresh.state) && Date.now() - (fresh.last_discovery_at || 0) > 600000) {
      this.db.run('UPDATE peers SET last_discovery_at=? WHERE id=?', Date.now(), peer.id);
      const r = await this.call(fresh, 'GET', '/federation/v1/peers', { maxBytes: 512 * 1024 });
      const self = this.self();
      for (const c of (Array.isArray(r.peers) ? r.peers : []).slice(0, 25)) {
        try {
          if (!c || c.account === self.account || !isAccountId(c.account)) continue;
          if (this.byAccount(c.account)) continue;
          const p = this.addContact(c.account, c.endpoint, c.name); if (!p) continue;
          this.log.debug('discovered peer ' + p.endpoint);
        } catch { /* invalid or full: ignore */ }
      }
    }
    this.followAnnouncements();
  }
  /** If a known peer's signed announcement lists a new endpoint, register it (identity unchanged, verified by hello). */
  followAnnouncements() {
    for (const p of this.list().filter((x) => x.account_id && x.state !== 'blocked')) {
      const a = this.db.get('SELECT endpoints FROM endpoint_announces WHERE actor_id=?', p.account_id);
      if (!a) continue;
      for (const ep of JSON.parse(a.endpoints)) {
        try {
          const origin = validateEndpoint(ep, { allowPrivate: this.cfg.allowPrivatePeers });
          if (origin !== p.endpoint && !this.db.get('SELECT 1 x FROM peers WHERE endpoint=?', origin)) {
            this.db.run('INSERT INTO peers(endpoint,pin,state,name,created_at,sync_content) VALUES(?,?,?,?,?,?)', origin, p.account_id, p.state, p.name, Date.now(), p.sync_content || 0);
          }
        } catch { /* ignore invalid announced endpoint */ }
      }
    }
  }

  /** Ask healthy peers for events that fill detected sequence gaps. */
  async repairGaps() {
    if (this.contentMode() !== 'trusted') return;
    const gaps = this.ledger.openGaps();
    if (!gaps.length) return;
    const peers = this.list().filter((p) => p.account_id && this.syncAllowed(p) && p.fail_streak === 0).slice(0, 3);
    for (const g of gaps.slice(0, 5)) for (const p of peers) {
      try { const s = { accepted: 0 }; await this.fillGap(p, g.actor_id, g.expected_seq, s); if (!this.ledger.openGaps().some((x) => x.actor_id === g.actor_id)) break; } catch { /* try next peer */ }
    }
  }

  // ---------- scheduling ----------
  start() {
    if (this.timer || !this.cfg.federationEnabled) return;
    this.bootstrap();
    this.announceEndpoint();
    const every = Math.max(200, Math.min(this.cfg.syncIntervalMs, 5000));
    this.timer = setInterval(() => this.tick().catch(() => {}), every); this.timer.unref();
    setTimeout(() => this.tick().catch(() => {}), 50).unref();
  }
  async tick() {
    if (this.running || this.stopped || !this.enabled) return;
    this.running = true;
    try {
      const now = Date.now();
      // trusted/bootstrap peers get a light link check; only sync_content peers get a content sync (and only when mode='trusted')
      const due = this.list().filter((p) => (this.syncAllowed(p) || p.state === 'trusted' || p.state === 'bootstrap') && p.state !== 'blocked' && p.next_retry_at <= now && !this.inflight.has(p.id)).slice(0, 3);
      await Promise.allSettled(due.map((p) => this.syncPeer(p)));
      await this.repairGaps();
    } finally { this.running = false; }
  }
  /** Tell peers we have new events (they pull with their own cursor). Debounced, best effort. */
  poke() {
    if (!this.enabled || this.pokeTimer || this.stopped) return;
    this.pokeTimer = setTimeout(async () => {
      this.pokeTimer = null;
      for (const p of this.list().filter((x) => x.account_id && this.syncAllowed(x) && x.fail_streak === 0).slice(0, 20)) {
        this.call(p, 'POST', '/federation/v1/poke', { body: {} }).catch(() => {});
      }
    }, 150);
    this.pokeTimer.unref();
  }
  syncSoon(accountId) {
    const p = this.byAccount(accountId);
    if (!p || !this.syncAllowed(p)) return;
    const last = this.lastPoke.get(accountId) || 0;
    if (Date.now() - last < 1000) return;
    this.lastPoke.set(accountId, Date.now());
    this.syncPeer(p).catch(() => {});
  }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); if (this.pokeTimer) clearTimeout(this.pokeTimer); this.timer = null; }

  announceEndpoint() {
    const self = this.self();
    if (!self || !self.endpoint) return;
    const cur = this.db.get('SELECT endpoints FROM endpoint_announces WHERE actor_id=?', self.account);
    if (cur && JSON.parse(cur.endpoints)[0] === self.endpoint) return;
    try { this.ledger.publish(self.account, 'endpoint.announce', { endpoints: [self.endpoint], name: String(self.name || '').slice(0, 60) }); this.log.info('Published signed endpoint announcement'); this.bus.emit('local-publish'); } catch (e) { this.log.warn('endpoint announce failed: ' + (e.code || e.message)); }
  }

  // ---------- media from peers ----------
  /** Fetch a public media object from the hubs that reference it; verifies the content hash before storing. */
  fetchMedia(hash, hintAccount) {
    if (this.mediaJobs.has(hash)) return this.mediaJobs.get(hash);
    const job = this._fetchMedia(hash, hintAccount).finally(() => this.mediaJobs.delete(hash));
    this.mediaJobs.set(hash, job);
    return job;
  }

  /**
   * Stream a public media object from a peer with optional HTTP Range (WP6).
   * Pipes bytes to the client response without waiting for a full local cache.
   * Also kicks off a background full fetch so subsequent hits are local.
   */
  async proxyMediaRange(hash, hintAccount, { rangeHeader, res, maxBytes }) {
    const self = this.self();
    const candidates = [];
    if (hintAccount) {
      const p = this.byAccount(hintAccount);
      if (p && p.state !== 'blocked') candidates.push(p);
    }
    if (!candidates.length) { // origin unknown: fall back to trusted peers only (never ask random contacts about a hash)
      for (const p of this.list()) { if (p.state === 'trusted' || p.state === 'bootstrap') candidates.push(p); }
    }
    let lastErr = null;
    for (const p of candidates.slice(0, 5)) {
      if (!p.account_id) continue;
      try {
        // Ensure we have keys for signing
        if (!p.account_id) continue;
        const pathQuery = `/federation/v1/media/${hash}`;
        const headers = signRequest(this.ks, self.account, {
          method: 'GET', pathQuery, body: undefined, aud: p.account_id, endpoint: self.endpoint || undefined,
        });
        if (rangeHeader) headers.Range = rangeHeader;
        let wroteHead = false;
        await this.transport.streamProxy(p.endpoint, { method: 'GET', path: pathQuery, headers }, {
          maxBytes: maxBytes || this.cfg.maxUploadBytes,
          onHeaders: (status, rh) => {
            if (status !== 200 && status !== 206) return false;
            // Never trust the origin's Content-Type: only passive media types may render inline, everything else downloads.
            const ct = String(rh['content-type'] || '').split(';')[0].trim().toLowerCase();
            const passive = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm|quicktime|ogg)|audio\/(mpeg|ogg|wav|mp4|flac|webm))$/.test(ct);
            const out = {
              'Content-Type': passive ? ct : 'application/octet-stream',
              'Accept-Ranges': 'bytes',
              'X-Content-Type-Options': 'nosniff',
              'Content-Security-Policy': "sandbox; default-src 'none'; media-src 'self'; img-src 'self'; style-src 'unsafe-inline'",
              'Cross-Origin-Resource-Policy': 'same-origin',
              'Cache-Control': 'private, max-age=300',
            };
            if (!passive) out['Content-Disposition'] = 'attachment; filename="download"';
            if (rh['content-length']) out['Content-Length'] = rh['content-length'];
            if (rh['content-range']) out['Content-Range'] = rh['content-range'];
            if (rh['etag']) out.ETag = rh['etag'];
            res.writeHead(status, out);
            wroteHead = true;
            return true;
          },
          onData: (c) => { if (!res.writableEnded) res.write(c); },
          onEnd: () => { if (!res.writableEnded) res.end(); },
        });
        // Remote media is NEVER mirrored to disk unless the owner opted in (HUB_REMOTE_CACHE_MB > 0).
        if (this.cfg.remoteCacheBytes > 0) this.fetchMedia(hash, p.account_id).catch(() => {});
        return true;
      } catch (e) {
        lastErr = e;
        if (!res.headersSent) { /* try next peer */ }
        else { try { res.destroy(); } catch { /* ok */ } throw e; }
      }
    }
    throw lastErr || Object.assign(new Error('no_peers'), { code: 'no_peers' });
  }

  async _fetchMedia(hash, hintAccount) {

    if (!this.enabled) throw Object.assign(new Error('federation_disabled'), { code: 'federation_disabled' });
    const peers = this.list().filter((p) => p.account_id && p.state !== 'blocked');
    peers.sort((a, b) => (b.account_id === hintAccount) - (a.account_id === hintAccount) || a.fail_streak - b.fail_streak);
    const self = this.self();
    let lastErr;
    for (const p of peers.slice(0, 4)) {
      const tmp = path.join(this.cfg.uploadDir, 'tmp', 'dl-' + crypto.randomBytes(8).toString('hex'));
      try {
        const pathQuery = `/federation/v1/media/${hash}`;
        const headers = signRequest(this.ks, self.account, { method: 'GET', pathQuery, body: undefined, aud: p.account_id });
        const d = await this.transport.download(p.endpoint, { method: 'GET', path: pathQuery, headers }, tmp, this.cfg.maxUploadBytes);
        if (d.sha256 !== hash) { fs.unlinkSync(tmp); throw Object.assign(new Error('hash_mismatch'), { code: 'hash_mismatch' }); }
        if (this.cfg.remoteCacheBytes < d.size) { fs.unlinkSync(tmp); throw Object.assign(new Error('cache_disabled'), { code: 'cache_disabled' }); }
        this.media.evictRemote(d.size);
        const meta = this.db.get("SELECT 1 x FROM post_media WHERE hash=?", hash) && this._expectedMeta(hash);
        return this.media.adopt({ tmpPath: tmp, size: d.size, sha256: d.sha256, head: d.head, filename: meta?.name || 'remote' }, null, { origin: 'remote', originActor: p.account_id });
      } catch (e) { lastErr = e; try { fs.unlinkSync(tmp); } catch { /* none */ } }
    }
    throw lastErr || Object.assign(new Error('no_peers'), { code: 'no_peers' });
  }
  _expectedMeta(hash) {
    const row = this.db.get('SELECT p.media FROM post_media pm JOIN posts p ON p.id=pm.post_id WHERE pm.hash=? LIMIT 1', hash);
    try { return JSON.parse(row.media).find((m) => m.hash === hash); } catch { return null; }
  }

  status() {
    const all = this.list();
    const shown = all.filter((p) => !(p.state === 'discovered' && !p.sync_content));
    const peers = shown.map((p) => ({
      id: p.id, account_id: p.account_id, endpoint: undefined, machine_code: machineCodeOf(p),
      name: p.name, state: p.state, health: this.health(p),
      last_ok: p.last_ok, last_sync_at: p.last_sync_at, last_error: p.last_error, error_count: p.error_count, fail_streak: p.fail_streak,
      next_retry_at: p.next_retry_at, events_received: p.events_received, events_rejected: p.events_rejected, cursor: p.remote_cursor, pinned: !!p.pin, sync_content: !!p.sync_content,
    }));
    const head = this.ledger.head();
    return {
      enabled: this.enabled, protocol: PROTOCOL, self: this.self(), public_url_configured: !!this.cfg.publicUrl, content_sync: this.contentMode(), contacts: all.length - shown.length,
      peers, healthy: peers.filter((p) => p.health === 'healthy').length, total: peers.length,
      ledger: { events: head.n, head: head.lid, open_gaps: this.ledger.openGaps().length, conflicts: this.ledger.conflicts(5).length },
      last_sync_at: peers.reduce((m, p) => Math.max(m, p.last_sync_at || 0), 0) || null,
    };
  }
}
module.exports = { PeerManager, STATES };
