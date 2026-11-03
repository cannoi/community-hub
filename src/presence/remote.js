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

  async _fetch(account) {
    const peer = await this._resolvePeer(account);
    let r;
    try { r = await this.peers.call(peer, 'GET', `/federation/v1/actor/${account}/snapshot?limit=30`, { maxBytes: 512 * 1024 }); }
    catch (e) {
      this.db.run('INSERT INTO remote_actors(actor_id,head_seq,fetched_at,last_error) VALUES(?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET last_error=excluded.last_error', account, null, 0, String(e.code || e.message).slice(0, 60));
      throw new HttpError(502, 'E_REMOTE_UNREACHABLE', 'Cannot reach this Hub: ' + (e.code || e.message));
    }
    const list = Array.isArray(r && r.events) ? r.events.slice(0, 120) : [];
    const now = Date.now(); const good = []; let rejected = 0;
    for (const ev of list) {
      try {
        if (!ev || ev.actor_id !== account || !ALLOWED.has(ev.event_type)) throw new Error('not allowed');
        verifyEnvelope(ev, now);                      // shape + id + actor binding + Ed25519 signature
        good.push(ev);
      } catch { rejected++; }
    }
    this.db.tx(() => {
      for (const ev of good) {
        this.db.run('INSERT OR REPLACE INTO remote_cache(event_id,actor_id,sequence,event_type,created_at,body,fetched_at) VALUES(?,?,?,?,?,?,?)', ev.event_id, account, ev.sequence, ev.event_type, ev.created_at, JSON.stringify(ev), now);
        const media = ev.event_type === 'profile.update' ? (ev.payload.avatar ? [{ hash: ev.payload.avatar, mime: 'image/png', size: 0, name: 'avatar' }] : []) : (ev.payload.media || []);
        for (const m of media) this.db.run('INSERT OR REPLACE INTO remote_media_refs(hash,actor_id,mime,size,name,seen_at) VALUES(?,?,?,?,?,?)', m.hash, account, m.mime, m.size, m.name, now);
      }
      this.db.run('INSERT INTO remote_actors(actor_id,head_seq,fetched_at,last_error) VALUES(?,?,?,NULL) ON CONFLICT(actor_id) DO UPDATE SET head_seq=excluded.head_seq, fetched_at=excluded.fetched_at, last_error=NULL', account, Number.isSafeInteger(r.head_seq) ? r.head_seq : null, now);
      this._prune(account, now);
    });
    if (rejected) this.log.warn(`remote snapshot: ${rejected} invalid event(s) ignored`);
    return { accepted: good.length, rejected };
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
  }
  forget(account) { for (const t of ['remote_cache', 'remote_media_refs', 'remote_actors']) this.db.run(`DELETE FROM ${t} WHERE actor_id=?`, account); }

  /** Pure projection of verified, same-actor events: profile (last wins), posts with edits applied and tombstones removed. */
  view(account, extra = {}) {
    const evs = this.db.all('SELECT body FROM remote_cache WHERE actor_id=? ORDER BY sequence ASC', account).map((r) => JSON.parse(r.body));
    const meta = this.db.get('SELECT head_seq, fetched_at, last_error FROM remote_actors WHERE actor_id=?', account) || {};
    const prof = {}; const posts = new Map();
    for (const ev of evs) {
      const p = ev.payload;
      if (ev.event_type === 'profile.update') { if (p.display_name !== undefined) prof.display_name = p.display_name; if (p.bio !== undefined) prof.bio = p.bio; if (p.avatar !== undefined) prof.avatar = p.avatar; }
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
