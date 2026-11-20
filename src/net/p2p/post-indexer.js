'use strict';
/**
 * Phase 6 — bridges the Hub's social data to the distributed index, strictly PUBLIC-only.
 *
 *  PostIndexer       : keeps `p2p_index_documents` (origin = this Hub) in sync with eligible posts: new, edited, deleted, no longer
 *                      public. Incremental + time/row bounded, idempotent (content-hash comparison), safe to re-run at any time.
 *  isStillPublic()   : source-of-truth check used by the search responder before serving one of OUR documents.
 *  createContentProvider(): the origin-side release of full post content. This is where access is decided — for a remote Hub the
 *                      answer is "public posts only"; private/followers/group/unknown/deleted-private all look like `not_found`.
 *
 * Never indexed: group posts, followers-only posts, replies, reposts, direct messages, drafts, remote (origin != local) posts, media bytes.
 */
const crypto = require('crypto');
const ST = require('./search-text');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ELIGIBLE = "p.origin='local' AND p.event_id IS NOT NULL AND p.group_id IS NULL AND p.parent_event IS NULL AND p.kind IN ('post','quote') AND p.visibility='public' AND p.deleted_at IS NULL";

class PostIndexer {
  /** @param {{db:object, index:object, selfId:function|string, region?:string, log?:object, batch?:number}} o */
  constructor(o) {
    this.db = o.db; this.index = o.index; this._self = o.selfId; this.region = String(o.region || 'ZZ').toUpperCase().slice(0, 2) || 'ZZ';
    this.log = o.log || { debug() {}, warn() {} }; this.batch = o.batch || 200;
    this.cur = { added: 0, edited: 0, deleted: 0, sweep: '', audit: '' }; this._timer = null; this.stats = { indexed: 0, removed: 0, last: 0 };
  }
  selfId() { return String(typeof this._self === 'function' ? this._self() : this._self || ''); }

  _doc(r) {
    const tags = this.db.all('SELECT tag FROM post_tags WHERE post_id=? LIMIT 8', r.id).map((x) => x.tag);
    const text = String(r.content || '').slice(0, 2000);
    return { origin_peer: this.selfId(), content_id: r.event_id, visibility: 'public', title: '', text, language: ST.detectLanguage(text).lang,
      region: this.region, topics: [...new Set([...ST.mapTopics(text), ...tags])].slice(0, 12), updated_at: Number(r.edited_at || r.sort_ts) || Date.now() };
  }
  _put(r) {
    if (!String(r.content || '').trim()) return false;
    const res = this.index.upsertDocument(this._doc(r), { local: true });
    if (res.ok && !res.unchanged) { this.stats.indexed++; return true; }
    return false;
  }
  _drop(eventId) { const ok = this.index.removeDocument(this.selfId(), eventId); if (ok) this.stats.removed++; return ok; }

  /** One bounded pass. Returns counts; call again while `more` is true. */
  sync({ budget = this.batch } = {}) {
    const self = this.selfId(); if (!self) return { indexed: 0, removed: 0, more: false, skipped: 'no_identity' };
    let indexed = 0, removed = 0, more = false;
    // (A) new posts after the cursor, (B) edits after the edit watermark
    for (const r of this.db.all(`SELECT p.id,p.event_id,p.content,p.sort_ts,p.edited_at FROM posts p WHERE ${ELIGIBLE} AND p.id>? ORDER BY p.id LIMIT ?`, this.cur.added, budget)) { this.cur.added = r.id; if (this._put(r)) indexed++; }
    for (const r of this.db.all(`SELECT p.id,p.event_id,p.content,p.sort_ts,p.edited_at FROM posts p WHERE ${ELIGIBLE} AND p.edited_at>? ORDER BY p.edited_at LIMIT ?`, this.cur.edited, budget)) { this.cur.edited = Math.max(this.cur.edited, r.edited_at); if (this._put(r)) indexed++; }
    // (C) deletions: fast path by deleted_at watermark …
    for (const r of this.db.all("SELECT event_id,deleted_at FROM posts WHERE origin='local' AND event_id IS NOT NULL AND deleted_at>? ORDER BY deleted_at LIMIT ?", this.cur.deleted, budget)) { this.cur.deleted = Math.max(this.cur.deleted, r.deleted_at); if (this._drop(r.event_id)) removed++; }
    // … and a rolling sweep over our own index documents so anything that stopped being public (any cause) disappears too
    const docs = this.db.all("SELECT content_id FROM p2p_index_documents WHERE origin_peer=? AND content_id>? ORDER BY content_id LIMIT ?", self, this.cur.sweep, budget);
    for (const d of docs) if (!this.isStillPublic(d.content_id)) { if (this._drop(d.content_id)) removed++; }
    this.cur.sweep = docs.length < budget ? '' : docs[docs.length - 1].content_id;
    more = this.db.get(`SELECT 1 x FROM posts p WHERE ${ELIGIBLE} AND p.id>? LIMIT 1`, this.cur.added) ? true : docs.length >= budget;
    this.stats.last = Date.now();
    return { indexed, removed, more };
  }
  /** Run to completion (bounded loops). */
  syncAll(maxRounds = 200) { let t = { indexed: 0, removed: 0 }; for (let i = 0; i < maxRounds; i++) { const r = this.sync(); t.indexed += r.indexed; t.removed += r.removed; if (!r.more) break; } return t; }

  /** Phase 7: compare our index documents with the posts they came from. Returns findings; repair() fixes ONE document. */
  audit({ limit = 200 } = {}) {
    const self = this.selfId(); if (!self) return [];
    const docs = this.db.all('SELECT content_id,title,body,content_hash FROM p2p_index_documents WHERE origin_peer=? AND content_id>? ORDER BY content_id LIMIT ?', self, this.cur.audit || '', limit);
    const out = [];
    for (const d of docs) {
      if (sha256(d.title + '\n' + d.body) !== d.content_hash) { out.push({ subject: d.content_id, kind: 'corrupt_doc', severity: 'warn', detail: {} }); continue; }
      if (!this.isStillPublic(d.content_id)) { out.push({ subject: d.content_id, kind: 'stale_doc', severity: 'warn', detail: {} }); continue; }
      const p = this.db.get('SELECT content FROM posts WHERE event_id=?', d.content_id);
      if (p && sha256('\n' + String(p.content || '').slice(0, 2000)) !== d.content_hash) out.push({ subject: d.content_id, kind: 'outdated_doc', severity: 'warn', detail: {} });
    }
    this.cur.audit = docs.length < limit ? '' : docs[docs.length - 1].content_id;
    return out;
  }
  repair(eventId) {
    const id = String(eventId); const r = this.db.get(`SELECT p.id,p.event_id,p.content,p.sort_ts,p.edited_at FROM posts p WHERE ${ELIGIBLE} AND p.event_id=?`, id);
    this.db.run('DELETE FROM p2p_index_documents WHERE origin_peer=? AND content_id=?', this.selfId(), id);      // derived data: rebuilt from the post (or dropped when no longer public)
    this.db.run('DELETE FROM p2p_index_terms WHERE origin_peer=? AND content_id=?', this.selfId(), id);
    if (r) this._put(r);
    return true;
  }

  isStillPublic(eventId) { return !!this.db.get(`SELECT 1 x FROM posts p WHERE ${ELIGIBLE} AND p.event_id=?`, String(eventId)); }

  start({ bus = null, intervalMs = 60000 } = {}) {
    this.stop(); const run = () => { try { this.sync(); } catch (e) { this.log.warn('post indexer: ' + (e && e.message)); } };
    let pending = null; const kick = () => { if (!pending) pending = setTimeout(() => { pending = null; run(); }, 300); if (pending.unref) pending.unref(); };
    if (bus && typeof bus.on === 'function') { this._bus = bus; this._kick = kick; bus.on('local-publish', kick); bus.on('events', kick); }
    this._timer = setInterval(run, intervalMs); if (this._timer.unref) this._timer.unref();
    kick();
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; if (this._bus && this._kick) { this._bus.off('local-publish', this._kick); this._bus.off('events', this._kick); } this._bus = null; }
}

/**
 * Origin-side release of full post content to another Hub. Returns signed ledger events (self-verifying: the requester checks
 * every account signature itself), never raw database rows.
 */
function createContentProvider({ db }) {
  return async function contentProvider(contentId, { have_hash = '' } = {}) {
    const id = String(contentId);
    const row = db.get('SELECT p.id,p.event_id,p.content,p.visibility,p.deleted_at,p.group_id,p.parent_event,p.kind,p.origin FROM posts p WHERE p.event_id=?', id);
    if (!row || row.origin !== 'local') return { status: 'not_found' };
    // Access is decided HERE, at the source. A remote Hub only ever receives PUBLIC top-level posts.
    if (row.visibility !== 'public' || row.group_id || row.parent_event || !['post', 'quote'].includes(row.kind)) return { status: 'not_found' };
    if (row.deleted_at) return { status: 'gone' };
    const hash = sha256('\n' + String(row.content || ''));
    if (have_hash && have_hash === hash) return { status: 'unchanged', content_hash: hash };
    const create = db.get("SELECT body FROM events WHERE event_id=? AND event_type='post.create'", id);
    if (!create) return { status: 'not_found' };
    const cev = JSON.parse(create.body); const events = [cev];
    const edits = db.all("SELECT body FROM events WHERE actor_id=? AND event_type='post.edit' ORDER BY sequence DESC LIMIT 60", cev.actor_id).map((r) => JSON.parse(r.body)).filter((e) => e.target === id);
    if (edits.length) events.push(edits[0]);
    return { status: 'ok', events, content_hash: hash };
  };
}

module.exports = { PostIndexer, createContentProvider, ELIGIBLE };
