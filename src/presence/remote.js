'use strict';
// On-demand remote content ("Local Content"): opening someone's profile fetches a SMALL signed snapshot from their own Hub,
// verifies every event locally, and keeps it in a bounded, expiring cache. Nothing here enters the ledger or the local
// posts table, and no media bytes are stored (media is streamed through when a viewer actually opens it).
const { verifyEnvelope } = require('../ledger');
const { isAccountId } = require('../keystore');
const { HttpError } = require('../util');

const ALLOWED = new Set(['profile.update', 'post.create', 'post.edit', 'post.delete']);
const SAFE_IMG = /^image\/(png|jpeg|gif|webp)$/; const SAFE_VID = /^video\/(mp4|webm|quicktime|ogg)$/; const SAFE_AUD = /^audio\/(mpeg|ogg|wav|mp4|flac|webm)$/;
const kindOf = (mime) => (SAFE_IMG.test(mime) ? 'image' : SAFE_VID.test(mime) ? 'video' : SAFE_AUD.test(mime) ? 'audio' : 'document');

class RemoteContent {
  constructor({ db, cfg, log, peers, presence, ledger }) {
    Object.assign(this, { db, cfg, log, peers, presence, ledger });
    this.jobs = new Map();
    this.stats = { fetches: 0, delta_fetches: 0, unchanged: 0, events_received: 0, divergences: 0, tombstoned_skips: 0 };
  }

  // ---------- Phase 7: durable tombstones (a deleted post must never reappear because its delete event left the cache) ----------
  /** Is this content id known-deleted, even when we hold no cached copy of it? (event ids are content hashes, so the id alone is unambiguous) */
  tombstonedPost(contentId) { return !!this.db.get('SELECT 1 x FROM remote_tombstones WHERE target_event=? LIMIT 1', String(contentId)); }
  tombstone(actor, target) { return this.db.get('SELECT deleted_seq, deleted_at FROM remote_tombstones WHERE actor_id=? AND target_event=?', actor, target) || null; }
  _tomb(actor, target, seq, at, now) {
    this.db.run('INSERT INTO remote_tombstones(actor_id,target_event,deleted_seq,deleted_at,recorded_at) VALUES(?,?,?,?,?) ON CONFLICT(actor_id,target_event) DO UPDATE SET deleted_seq=MAX(deleted_seq,excluded.deleted_seq), recorded_at=excluded.recorded_at',
      actor, target, seq, at, now);
    this.db.run("DELETE FROM remote_cache WHERE actor_id=? AND event_id=? AND event_type='post.create'", actor, target);
    for (const r of this.db.all("SELECT event_id, body FROM remote_cache WHERE actor_id=? AND event_type='post.edit'", actor)) { try { if (JSON.parse(r.body).target === target) this.db.run('DELETE FROM remote_cache WHERE event_id=?', r.event_id); } catch { /* ignore */ } }
  }
  /** Store verified events of ONE actor; honours tombstones in both directions. Must run inside a transaction. */
  _store(account, list, now) {
    let stored = 0;
    for (const ev of list) if (ev.event_type === 'post.delete' && typeof ev.target === 'string') this._tomb(account, ev.target, ev.sequence, ev.created_at, now);
    for (const ev of list) {
      const tgt = ev.event_type === 'post.create' ? ev.event_id : ev.event_type === 'post.edit' ? ev.target : null;
      if (tgt) { const t = this.tombstone(account, tgt); if (t && ev.sequence < t.deleted_seq) { this.stats.tombstoned_skips++; continue; } }
      this.db.run('INSERT OR REPLACE INTO remote_cache(event_id,actor_id,sequence,event_type,created_at,body,fetched_at) VALUES(?,?,?,?,?,?,?)', ev.event_id, account, ev.sequence, ev.event_type, ev.created_at, JSON.stringify(ev), now);
      const media = ev.event_type === 'profile.update' ? (ev.payload.avatar ? [{ hash: ev.payload.avatar, mime: 'image/png', size: 0, name: 'avatar' }] : []) : (ev.payload.media || []);
      for (const m of media) this.db.run('INSERT OR REPLACE INTO remote_media_refs(hash,actor_id,mime,size,name,seen_at) VALUES(?,?,?,?,?,?)', m.hash, account, m.mime, m.size, m.name, now);
      stored++;
    }
    return stored;
  }
  finding(layer, subject, kind, detail, severity = 'warn') {
    try { this.db.run('INSERT OR IGNORE INTO integrity_findings(layer,subject,kind,severity,detail,status,detected_at) VALUES(?,?,?,?,?,?,?)', layer, String(subject).slice(0, 200), kind, severity, JSON.stringify(detail || {}).slice(0, 2000), 'open', Date.now()); } catch { /* table missing on very old DBs */ }
  }
  /** A cached post as signed events (create + latest edit) or {gone:true}; null when we hold nothing. Used for persistence and replica serving. */
  cachedPost(contentId) {
    const row = this.db.get("SELECT actor_id, body, fetched_at FROM remote_cache WHERE event_id=? AND event_type='post.create'", String(contentId));
    if (!row) return null;
    const create = JSON.parse(row.body);
    if (this.tombstone(create.actor_id, create.event_id)) return { gone: true };
    if (!['post', 'quote'].includes(create.payload && create.payload.kind)) return null;           // replies/reposts are never served onward
    const edits = this.db.all("SELECT body FROM remote_cache WHERE actor_id=? AND event_type='post.edit' ORDER BY sequence DESC LIMIT 60", create.actor_id).map((r) => JSON.parse(r.body)).filter((e) => e.target === contentId);
    return { events: edits.length ? [create, edits[0]] : [create], fetched_at: row.fetched_at };
  }
  forgetPost(contentId, { tombstone = false } = {}) {
    const row = this.db.get("SELECT actor_id, body FROM remote_cache WHERE event_id=? AND event_type='post.create'", String(contentId)); if (!row) return false;
    const create = JSON.parse(row.body);
    this.db.tx(() => { if (tombstone) this._tomb(create.actor_id, create.event_id, create.sequence + 1, Date.now(), Date.now()); else { this.db.run('DELETE FROM remote_cache WHERE event_id=?', contentId); } });
    return true;
  }

  /** Returns a view (profile + recent posts). Fetches live when the cache is older than `freshMs` or `force`. */
  async open(account, { force = false } = {}) {
    if (!isAccountId(account)) throw new HttpError(400, 'E_INVALID', 'Invalid account id');
    const self = this.peers.self(); if (self && self.account === account) throw new HttpError(400, 'E_REMOTE_SELF', 'This is your own account');
    if (this.ledger.isBlocked(account)) throw new HttpError(403, 'E_BLOCKED', 'You blocked this account');
    const meta = this.db.get('SELECT fetched_at FROM remote_actors WHERE actor_id=?', account);
    if (!force && meta && Date.now() - meta.fetched_at < this.cfg.remote.freshMs) return this.view(account, { source: 'cache' });
    try {
      await this._fetchOnce(account);
      return this.view(account, { source: 'live' });
    } catch (e) {
      const cached = this.db.get('SELECT 1 x FROM remote_cache WHERE actor_id=? LIMIT 1', account);
      if (cached) return this.view(account, { source: 'cache', stale: true, error: e.code || 'fetch_failed' });
      throw e;
    }
  }

  _fetchOnce(account) {
    if (this.jobs.has(account)) return this.jobs.get(account);
    const p = this._fetch(account).finally(() => this.jobs.delete(account));
    this.jobs.set(account, p); return p;
  }

  async _resolvePeer(account) {
    let peer = this.peers.byAccount(account);
    if (peer && peer.state === 'blocked') throw new HttpError(403, 'E_PEER_BLOCKED', 'Peer not permitted');
    let name = null;
    if (!peer || !peer.endpoint) {
      const r = await this.presence.resolve(account).catch((e) => { throw new HttpError(502, 'E_PRESENCE_UNAVAILABLE', 'Directory unavailable: ' + (e.code || e.message)); });
      if (!r) throw new HttpError(404, 'E_REMOTE_UNKNOWN', 'This account is not in the directory');
      if (!r.record.endpoint) throw new HttpError(502, 'E_REMOTE_UNREACHABLE', 'This Hub did not publish an address');
      name = r.record.name;
      try { peer = this.peers.addContact(account, r.record.endpoint, name); } catch (e) { throw new HttpError(502, 'E_REMOTE_UNREACHABLE', 'Cannot contact this Hub: ' + (e.code || e.message)); }
    }
    return peer;
  }

  async _fetch(account, { full = false } = {}) {
    const peer = await this._resolvePeer(account);
    const meta = this.db.get('SELECT fetched_at, snap_seq FROM remote_actors WHERE actor_id=?', account);
    const hasCache = !!this.db.get('SELECT 1 x FROM remote_cache WHERE actor_id=? LIMIT 1', account);
    // Delta only from the base of the last LIVE snapshot (passive discovery events are not contiguous and are never a delta base).
    let base = (!full && meta && meta.fetched_at > 0 && Number.isSafeInteger(meta.snap_seq) && meta.snap_seq >= 0 && hasCache) ? meta.snap_seq : null;
    const list = []; let head = null, through = null, delta = base !== null;
    try {
      if (!delta) { const r = await this.peers.call(peer, 'GET', `/federation/v1/actor/${account}/snapshot?limit=30`, { maxBytes: 512 * 1024 }); this.stats.fetches++; list.push(...(Array.isArray(r && r.events) ? r.events : [])); head = r.head_seq; through = Number.isSafeInteger(r.head_seq) ? r.head_seq : null; }
      else {
        let cur = base;
        for (let page = 0; page < 5; page++) {
          const r = await this.peers.call(peer, 'GET', `/federation/v1/actor/${account}/snapshot?limit=30&after=${cur}`, { maxBytes: 512 * 1024 }); this.stats.delta_fetches++;
          if (Number.isSafeInteger(r.head_seq) && r.head_seq < base) {                       // the origin's chain is SHORTER than what we already verified: rollback / different history
            this.stats.divergences++; this.finding('remote_cache', account, 'origin_rollback', { cached_seq: base, origin_head: r.head_seq }, 'warn');
            this.forget(account); return this._fetch(account, { full: true });
          }
          if (!r.delta) { list.push(...(Array.isArray(r.events) ? r.events : [])); head = r.head_seq; through = Number.isSafeInteger(r.head_seq) ? r.head_seq : null; delta = false; break; }   // old origin ignored `after`
          list.push(...(Array.isArray(r.events) ? r.events : [])); head = r.head_seq;
          if (!r.has_more) { through = Number.isSafeInteger(r.head_seq) ? r.head_seq : cur; break; }
          if (!Number.isSafeInteger(r.through_seq) || r.through_seq <= cur) break; cur = r.through_seq; through = cur;
        }
      }
    } catch (e) {
      this.db.run('INSERT INTO remote_actors(actor_id,head_seq,fetched_at,last_error) VALUES(?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET last_error=excluded.last_error', account, null, 0, String(e.code || e.message).slice(0, 60));
      throw new HttpError(502, 'E_REMOTE_UNREACHABLE', 'Cannot reach this Hub: ' + (e.code || e.message));
    }
    const now = Date.now(); const good = []; let rejected = 0;
    for (const ev of list.slice(0, 400)) {
      try {
        if (!ev || ev.actor_id !== account || !ALLOWED.has(ev.event_type)) throw new Error('not allowed');
        verifyEnvelope(ev, now);                      // shape + id + actor binding + Ed25519 signature
        good.push(ev);
      } catch { rejected++; }
    }
    this.stats.events_received += good.length;
    if (delta && !good.length && !rejected) {         // nothing changed at the origin: refresh the timestamp only, download nothing
      this.stats.unchanged++;
      this.db.run('UPDATE remote_actors SET fetched_at=?, last_error=NULL WHERE actor_id=?', now, account);
      return { accepted: 0, rejected: 0, unchanged: true };
    }
    this.db.tx(() => {
      this._store(account, good, now);
      this.db.run('INSERT INTO remote_actors(actor_id,head_seq,fetched_at,last_error,snap_seq) VALUES(?,?,?,NULL,?) ON CONFLICT(actor_id) DO UPDATE SET head_seq=excluded.head_seq, fetched_at=excluded.fetched_at, last_error=NULL, snap_seq=excluded.snap_seq', account, Number.isSafeInteger(head) ? head : null, now, rejected ? null : through);   // a rejected event must never be skipped by a later delta: no base unless EVERYTHING verified
      this._prune(account, now);
    });
    if (rejected) this.log.warn(`remote snapshot: ${rejected} invalid event(s) ignored`);
    return { accepted: good.length, rejected, delta };
  }

  /**
   * Passive discovery cache: verified public events of accounts the ledger does NOT hold (delivered by a sync peer) go here instead of
   * into the ledger. Same bounds as on-demand views (newest `perActor` per account, `maxEvents` in total, TTL), nothing is signed by us,
   * no media bytes. An existing live fetch time is never touched, so opening a profile still refreshes it from its own Hub.
   */
  cacheEvents(events) {
    const now = Date.now(); const byActor = new Map(); let accepted = 0; let rejected = 0;
    const self = this.peers.self();
    for (const ev of (Array.isArray(events) ? events : []).slice(0, 400)) {
      try {
        if (!ev || !isAccountId(ev.actor_id) || !ALLOWED.has(ev.event_type)) throw new Error('not allowed');
        if ((self && self.account === ev.actor_id) || this.ledger.isBlocked(ev.actor_id)) continue;
        verifyEnvelope(ev, now);
        if (!byActor.has(ev.actor_id)) byActor.set(ev.actor_id, []);
        byActor.get(ev.actor_id).push(ev);
      } catch { rejected++; }
    }
    this.db.tx(() => {
      for (const [account, list] of byActor) {
        accepted += this._store(account, list, now);
        const head = list.reduce((m, ev) => Math.max(m, ev.sequence), 0);
        this.db.run('INSERT INTO remote_actors(actor_id,head_seq,fetched_at,last_error) VALUES(?,?,0,NULL) ON CONFLICT(actor_id) DO UPDATE SET head_seq=MAX(COALESCE(remote_actors.head_seq,0), excluded.head_seq)', account, head);
        this._prune(account, now);
      }
    });
    return { accepted, rejected, actors: byActor.size };
  }

  _prune(account, now = Date.now()) {
    const c = this.cfg.remote;
    this.db.run('DELETE FROM remote_cache WHERE actor_id=? AND event_id NOT IN (SELECT event_id FROM remote_cache WHERE actor_id=? ORDER BY sequence DESC LIMIT ?)', account, account, c.perActor);
    this.purgeExpired(now);
    const over = this.db.get('SELECT COUNT(*) c FROM remote_cache').c - c.maxEvents;
    if (over > 0) this.db.run('DELETE FROM remote_cache WHERE event_id IN (SELECT event_id FROM remote_cache ORDER BY fetched_at ASC LIMIT ?)', over);
  }
  purgeExpired(now = Date.now()) {
    const cut = now - this.cfg.remote.ttlMs;
    this.db.run('DELETE FROM remote_cache WHERE fetched_at < ?', cut);
    this.db.run('DELETE FROM remote_media_refs WHERE seen_at < ?', cut);
    this.db.run('DELETE FROM remote_actors WHERE fetched_at < ? AND fetched_at > 0', cut);
    this.db.run('DELETE FROM remote_tombstones WHERE recorded_at < ?', now - (this.cfg.remote.tombstoneTtlMs || 30 * 86400000));
  }
  forget(account) { for (const t of ['remote_cache', 'remote_media_refs', 'remote_actors']) this.db.run(`DELETE FROM ${t} WHERE actor_id=?`, account); }

  /** Pure projection of verified, same-actor events: profile (last wins), posts with edits applied and tombstones removed. */
  view(account, extra = {}) {
    const evs = this.db.all('SELECT body FROM remote_cache WHERE actor_id=? ORDER BY sequence ASC', account).map((r) => JSON.parse(r.body));
    const meta = this.db.get('SELECT head_seq, fetched_at, last_error FROM remote_actors WHERE actor_id=?', account) || {};
    const prof = {}; const posts = new Map();
    const dead = new Set(this.db.all('SELECT target_event FROM remote_tombstones WHERE actor_id=?', account).map((r) => r.target_event));
    for (const ev of evs) {
      const p = ev.payload;
      if (ev.event_type === 'profile.update') { if (p.display_name !== undefined) prof.display_name = p.display_name; if (p.bio !== undefined) prof.bio = p.bio; if (p.avatar !== undefined) prof.avatar = p.avatar; }
      else if (ev.event_type === 'post.create' && dead.has(ev.event_id)) continue;
      else if (ev.event_type === 'post.create') posts.set(ev.event_id, { event_id: ev.event_id, kind: p.kind, content: p.content, media: p.media || [], created_at: ev.created_at, edited_at: null, deleted: false });
      else if (ev.event_type === 'post.edit') { const t = posts.get(ev.target); if (t) { t.content = p.content; t.media = p.media || []; t.edited_at = ev.created_at; } }
      else if (ev.event_type === 'post.delete') { const t = posts.get(ev.target); if (t) t.deleted = true; }
    }
    const list = [...posts.values()].filter((x) => !x.deleted).sort((a, b) => b.created_at - a.created_at).slice(0, 50)
      .map((x) => ({ event_id: x.event_id, kind: x.kind, content: x.content, created_at: new Date(x.created_at).toISOString(), edited_at: x.edited_at ? new Date(x.edited_at).toISOString() : null,
        media: x.media.map((m) => ({ hash: m.hash, mime: m.mime, size: m.size, name: m.name, kind: kindOf(m.mime), url: '/media/' + m.hash, available: true })) }));
    return {
      account_id: account,
      profile: { display_name: prof.display_name || null, bio: prof.bio || null, avatar_url: prof.avatar ? '/media/' + prof.avatar : null },
      posts: list, head_seq: meta.head_seq ?? null, fetched_at: meta.fetched_at ? new Date(meta.fetched_at).toISOString() : null,
      ...extra, stored: false, // explicit: this view is a transient cache, not part of your Hub's data
    };
  }
}
module.exports = { RemoteContent, kindOf };
