'use strict';
/**
 * Phase 6 — Federated Search and Global Explore engine.
 *
 *  SearchService   (responder): answers `search` / `browse` / `content` from this Hub's index. Every request is authenticated by the
 *                  transport peer identity, rate/cost limited, size limited and trust-gated BEFORE any index work happens.
 *  FederatedSearch (requester): Local -> Regional -> Language -> Topic -> Global. Progressive (snapshots are readable at any time),
 *                  bounded fan-out / timeouts / per-peer circuit breakers, replacement peers on failure, de-duplication,
 *                  local re-verification (content hash + origin signature) of EVERY remote result, local ranking.
 *
 * Privacy: only PUBLIC documents exist in the index (enforced at write time in DistributedIndex). In addition the responder re-checks
 * its OWN documents against the source of truth (`isStillPublic`) and the full content is only released by the origin Hub
 * (`contentProvider`), which performs the access check there. Finding metadata is never treated as permission to read content.
 */
const crypto = require('crypto');
const C = require('./index-crypto');
const ST = require('./search-text');
const RK = require('./search-ranking');
const { RateBucket } = require('./index-governor');

const MSG_TYPES = new Set(['search', 'browse', 'content']);
const DEFAULTS = {
  // responder
  maxTerms: 24, maxLimit: 30, rowCap: 120, maxQueryLen: 200, ratePerSec: 6, rateBurst: 30, maxContentBytes: 256 * 1024,
  // requester
  want: 20, fanout: 6, maxPeers: 24, maxPool: 1000, replacements: 2, stageTimeoutMs: 2500, totalTimeoutMs: 8000, perPeerLimit: 30,
  perPeerInflight: 8, throttleBaseMs: 1000, throttleMaxMs: 30000, breakerFails: 3, breakerBaseMs: 15000, breakerMaxMs: 600000, cacheTtlMs: 30000, cacheMax: 100,
  sessionTtlMs: 120000, maxSessions: 200, maxPerUser: 3, contentTtlMs: 600000, contentCacheMax: 300, minRelevance: 0.1,
  weights: RK.DEFAULT_WEIGHTS,
};
const STAGES = ['local', 'regional', 'language', 'topic', 'global'];
const PEER_RE = /^[1-9A-HJ-NP-Za-km-z]{20,80}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const monoNow = () => Number(process.hrtime.bigint() / 1000000n);
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const withTimeout = (p, ms) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'E_TIMEOUT' })), ms); })]).finally(() => clearTimeout(t)); };
const hubLabel = (peer, region) => `${region && region !== 'ZZ' ? region : '··'} · hub-${sha256(peer).slice(0, 4)}`;   // never the Peer ID

// ================================================================================================================ responder
class SearchService {
  /**
   * @param {{index:object, signer:object, selfId:string, trust?:object, governor?:object, isStillPublic?:function,
   *          contentProvider?:function, config?:object, now?:function, log?:object}} o
   */
  constructor(o) {
    this.index = o.index; this.signer = o.signer; this.self = String(o.selfId || o.signer.peerId);
    this.trust = o.trust || null; this.governor = o.governor || null;
    this.isStillPublic = o.isStillPublic || null; this.contentProvider = o.contentProvider || null; this.replicaProvider = o.replicaProvider || null;
    this.cfg = { ...DEFAULTS, ...(o.config || {}) }; this.now = o.now || monoNow; this.log = o.log || { debug() {}, warn() {} };
    this._rate = new RateBucket({ capacity: this.cfg.rateBurst, refillPerSec: this.cfg.ratePerSec, now: this.now });
    this._inflight = 0; this.metrics = { served: 0, rejected: {}, items: 0 };
  }
  _rej(reason) { this.metrics.rejected[reason] = (this.metrics.rejected[reason] || 0) + 1; return { ok: false, reason }; }
  concurrencyLimit() { return Math.max(2, (this.governor ? this.governor.concurrency() : 4) * 2); }

  async handle(from, msg) {
    try {
      if (!msg || typeof msg !== 'object' || !MSG_TYPES.has(msg.t)) return this._rej('bad_message');
      if (typeof from !== 'string' || from.length < 1 || from.length > 80) return this._rej('bad_peer');
      const ts = this.trust ? this.trust.stateOf(from) : 'TRUSTED';
      if (ts === 'BLOCKED' || ts === 'QUARANTINED') return this._rej('trust_' + ts.toLowerCase());
      const factor = { TRUSTED: 1, PROBATION: 0.6, NEW: 0.4, LIMITED: 0.15 }[ts] || 0.4;
      // Verify who is asking and whether they are within budget BEFORE touching the index (CPU/RAM-expensive work).
      const nTerms = Array.isArray(msg.terms) ? Math.min(msg.terms.length, 64) : 0;
      const cost = msg.t === 'content' ? 1 : 1 + Math.ceil(nTerms / 8);
      if (!this._rate.take(from, cost, factor)) return this._rej('rate_limited');
      if (this._inflight >= this.concurrencyLimit()) return this._rej('busy');
      if (this.governor && this.governor.pressure().reasons.includes('cpu') && msg.t !== 'content') return this._rej('busy');
      this._inflight++;
      try {
        if (msg.t === 'search') return await this._search(msg);
        if (msg.t === 'browse') return await this._browse(msg);
        return await this._content(from, msg);
      } finally { this._inflight--; }
    } catch (e) { this.log.warn('search handle: ' + (e && e.message)); return { ok: false, reason: 'internal' }; }
  }

  _filters(m) { return { language: m.language ? clip(m.language, 8) : undefined, region: m.region ? clip(m.region, 2).toUpperCase() : undefined, topic: m.topic ? clip(m.topic, 40) : undefined, strict: m.strict === true }; }

  async _search(m) {
    const terms = (Array.isArray(m.terms) ? m.terms : []).slice(0, this.cfg.maxTerms)
      .filter((x) => x && typeof x.t === 'string' && x.t.length >= 1 && x.t.length <= 48)
      .map((x) => ({ t: x.t, w: Math.max(0.1, Math.min(1, Number(x.w) || 1)) }));
    if (!terms.length) return this._rej('no_terms');
    const limit = Math.max(1, Math.min(this.cfg.maxLimit, Number(m.limit) || 20));
    const rows = this.index.searchWeighted(terms, { limit, rowCap: this.cfg.rowCap, ...this._filters(m) });
    return await this._finish(rows, limit);
  }
  async _browse(m) {
    const limit = Math.max(1, Math.min(this.cfg.maxLimit, Number(m.limit) || 20));
    const rows = this.index.recentDocuments({ limit, before: Number(m.before) || 0, ...this._filters(m) });
    return await this._finish(rows, limit);
  }
  /** Drop stale/private/unsigned rows, lazily sign our own, and bound the response size. */
  async _finish(rows, limit) {
    const out = []; let bytes = 0;
    for (const r of rows) {
      if (out.length >= limit) break;
      if (r.origin_peer === this.self) {
        if (this.isStillPublic && !this.isStillPublic(r.content_id)) { try { this.index.removeDocument(this.self, r.content_id); } catch { /* ignore */ } continue; }   // source of truth says no longer public
        if (!r.origin_sig) {
          r.origin_sig = await this.signer.sign(C.docPayload(r));
          try { this.index.db.run('UPDATE p2p_index_documents SET origin_sig=? WHERE origin_peer=? AND content_id=? AND content_hash=?', r.origin_sig, r.origin_peer, r.content_id, r.content_hash); } catch { /* ignore */ }
        }
      } else if (!r.origin_sig) continue;                                         // cannot be verified by the requester => never served
      const item = { origin_peer: r.origin_peer, content_id: r.content_id, title: r.title, text: r.text, language: r.language, region: r.region, topics: r.topics, content_hash: r.content_hash, updated_at: r.updated_at, origin_sig: r.origin_sig };
      bytes += JSON.stringify(item).length; if (bytes > 700 * 1024) break;
      out.push(item);
    }
    this.metrics.served++; this.metrics.items += out.length;
    return { ok: true, items: out, truncated: rows.length > out.length };
  }

  async _content(from, m) {
    const id = clip(m.content_id, 160); if (!id) return this._rej('bad_id');
    if (typeof this.contentProvider !== 'function' && typeof this.replicaProvider !== 'function') return this._rej('no_content_provider');
    let r = typeof this.contentProvider === 'function' ? await this.contentProvider(id, { have_hash: m.have_hash ? clip(m.have_hash, 64) : '', requester: from }) : { status: 'not_found' };
    // Replica path: when the origin is unreachable the requester may ask any holder. We only hand out SIGNED events we verified and cached
    // ourselves (public posts of other accounts, never deleted/tombstoned); the requester verifies every signature again itself.
    if ((!r || r.status === 'not_found') && m.replica_ok === true && typeof this.replicaProvider === 'function') {
      const c = this.replicaProvider(id);
      if (c && Array.isArray(c.events) && c.events.length) r = { status: 'ok', events: c.events.slice(0, 4), replica: true, fetched_at: c.fetched_at };
    }
    if (!r || typeof r !== 'object') return { ok: true, status: 'not_found' };
    if (JSON.stringify(r).length > this.cfg.maxContentBytes) return this._rej('too_large');
    return { ok: true, ...r };
  }
}

// ================================================================================================================ helpers
/** Project verified events into one post (edits/deletes only count when signed by the same actor as the post). */
function projectPost(events, contentId) {
  const evs = (Array.isArray(events) ? events : []).filter((e) => e && typeof e === 'object');
  const create = evs.find((e) => e.event_type === 'post.create' && e.event_id === contentId);
  if (!create) return null;
  const mine = evs.filter((e) => e.actor_id === create.actor_id && e.target === contentId);
  if (mine.some((e) => e.event_type === 'post.delete')) return { gone: true };
  const edits = mine.filter((e) => e.event_type === 'post.edit').sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  const last = edits[edits.length - 1];
  const p = create.payload || {};
  return { event_id: create.event_id, actor_id: create.actor_id, kind: p.kind, lang: p.lang || null, content: String((last ? last.payload.content : p.content) || ''), media: (last ? last.payload.media : p.media) || [],
    created_at: create.created_at, edited_at: last ? last.created_at : null };
}

// ================================================================================================================ requester
class FederatedSearch {
  /**
   * @param {{index:object, transport:object, signer:object, selfId?:string, peers:function, trust?:object, governor?:object,
   *          profile?:{region?:string,languages?:string[]}, translator?:function, verifyEvents?:function, contentProvider?:function,
   *          config?:object, now?:function, log?:object}} o
   *  peers(): () => [{peer_id, region, languages[], topics[]}]   routing HINTS only (directory / peer exchange); never trusted as facts.
   *  verifyEvents(events) -> number   verifies + caches signed ledger events (Hub: RemoteContent.cacheEvents); must throw/return 0 on bad input.
   */
  constructor(o) {
    this.index = o.index; this.transport = o.transport; this.signer = o.signer; this.self = String(o.selfId || o.signer.peerId);
    this.peers = o.peers || (() => []); this.trust = o.trust || null; this.governor = o.governor || null;
    this.profile = { region: String((o.profile && o.profile.region) || '').toUpperCase().slice(0, 2), languages: ((o.profile && o.profile.languages) || []).map(String) };
    this.translator = o.translator || null; this.verifyEvents = o.verifyEvents || null; this.localContent = o.contentProvider || null; this.store = o.contentStore || null;
    this._holders = new Map();
    this.cfg = { ...DEFAULTS, ...(o.config || {}) }; this.cfg.weights = { ...RK.DEFAULT_WEIGHTS, ...(this.cfg.weights || {}) };
    this.now = o.now || monoNow; this.log = o.log || { debug() {}, warn() {} };
    this._inflight = new Map(); this._sessions = new Map(); this._health = new Map(); this._cache = new Map(); this._content = new Map(); this._seq = 0;
    this.metrics = { sessions: 0, requests: 0, failures: 0, rejected_items: 0, cache_hits: 0, breaker_skips: 0, content_requests: 0, content_unchanged: 0, content_replica: 0, content_refreshed: 0 };
  }

  // ------------------------------------------------------------------ peer health (circuit breaker)
  _h(p) { let h = this._health.get(p); if (!h) { h = { fails: 0, openUntil: 0, lat: 0, ok: 0, total: 0 }; this._health.set(p, h); if (this._health.size > 2000) this._health.delete(this._health.keys().next().value); } return h; }
  _isOpen(p) { return this._h(p).openUntil > this.now(); }
  /** A peer that said rate_limited/busy (or that we are already hammering) is HEALTHY: back off briefly, never trip its breaker. */
  _throttle(p) { const h = this._h(p); h.thr = (h.thr || 0) + 1; h.throttleUntil = this.now() + Math.min(this.cfg.throttleMaxMs, this.cfg.throttleBaseMs * 2 ** (h.thr - 1)); }
  _isThrottled(p) { return (this._h(p).throttleUntil || 0) > this.now(); }
  _good(p, ms) { const h = this._h(p); h.fails = 0; h.openUntil = 0; h.thr = 0; h.throttleUntil = 0; h.ok++; h.total++; h.lat = h.lat ? 0.7 * h.lat + 0.3 * ms : ms; }
  _bad(p) {
    const h = this._h(p); h.fails++; h.total++;
    if (h.fails >= this.cfg.breakerFails) h.openUntil = this.now() + Math.min(this.cfg.breakerMaxMs, this.cfg.breakerBaseMs * 2 ** (h.fails - this.cfg.breakerFails)) + Math.floor(Math.random() * 1000);
  }
  health() { return [...this._health.entries()].map(([peer, h]) => ({ peer: hubLabel(peer, ''), fails: h.fails, open: h.openUntil > this.now(), latency_ms: Math.round(h.lat) })); }

  // ------------------------------------------------------------------ session lifecycle
  /** Start a search session. Returns immediately; call snapshot(id) any time (progressive results). */
  start(params = {}) {
    const q = String(params.q || '').trim();
    const mode = q ? 'search' : 'browse';
    const user = String(params.user || 'anon');
    let mine = 0; for (const s of this._sessions.values()) if (s.user === user && s.state === 'searching') mine++;
    if (mine >= this.cfg.maxPerUser) throw Object.assign(new Error('too many concurrent searches'), { code: 'E_BUSY' });
    this._gc();
    const filters = { language: params.language ? clip(params.language, 8) : '', region: params.region ? clip(params.region, 2).toUpperCase() : '', topic: params.topic ? clip(params.topic, 40) : '' };
    const scope = ['local', 'global', 'auto'].includes(params.scope) ? params.scope : 'auto';
    const key = sha256(JSON.stringify([q.toLowerCase(), filters, scope, params.languages || this.profile.languages]));
    const sess = { id: 's' + (++this._seq).toString(36) + crypto.randomBytes(5).toString('hex'), user, q, mode, filters, scope, key, createdAt: this.now(), t0: Date.now(), state: 'searching',
      want: Math.max(5, Math.min(50, Number(params.want) || this.cfg.want)), items: new Map(), stages: STAGES.map((s) => ({ stage: s, state: 'pending', peers: 0, ok: 0, failed: 0, items: 0 })),
      sources: { queried: 0, ok: 0, failed: 0, skipped_open: 0, throttled: 0, rejected_items: 0 }, version: 0, cached: false, cancel: false,
      langs: (params.languages && params.languages.length ? params.languages : this.profile.languages).map(String), verified: new Map() };
    this._sessions.set(sess.id, sess); this.metrics.sessions++;
    const hit = this._cache.get(key);
    if (hit && this.now() - hit.at < this.cfg.cacheTtlMs && scope !== 'global') {
      this.metrics.cache_hits++; sess.cached = true; sess.analysis = hit.analysis; for (const [k, v] of hit.items) sess.items.set(k, v);
      for (const st of sess.stages) st.state = 'cached'; sess.state = 'complete'; sess.done = Promise.resolve(sess); return sess;
    }
    sess.done = this._run(sess, params).catch((e) => { this.log.warn('search run: ' + (e && e.message)); }).then(() => { if (sess.state === 'searching') sess.state = this._finalState(sess); this._store(sess); return sess; });
    return sess;
  }
  /** Convenience: run to completion. */
  async search(params) { const s = this.start(params); await s.done; return this.snapshot(s.id, { offset: 0, limit: params.limit || 20 }); }
  /** Owner of a session (routes use this so one user can never read another user's session). */
  sessionUser(id) { const s = this._sessions.get(id); return s ? s.user : null; }
  cancel(id) { const s = this._sessions.get(id); if (s) { s.cancel = true; if (s.state === 'searching') s.state = 'cancelled'; } }
  _gc() {
    const t = this.now();
    for (const [id, s] of this._sessions) if (t - s.createdAt > this.cfg.sessionTtlMs && s.state !== 'searching') this._sessions.delete(id);
    while (this._sessions.size >= this.cfg.maxSessions) { const oldest = [...this._sessions.values()].filter((x) => x.state !== 'searching').sort((a, b) => a.createdAt - b.createdAt)[0]; if (!oldest) break; this._sessions.delete(oldest.id); }
  }
  _store(sess) {
    if (sess.state !== 'complete' && sess.state !== 'partial') return;
    this._cache.set(sess.key, { at: this.now(), analysis: sess.analysis, items: [...sess.items] });
    while (this._cache.size > this.cfg.cacheMax) this._cache.delete(this._cache.keys().next().value);
  }
  _finalState(sess) {
    const remote = sess.sources.queried; if (sess.scope === 'local') return 'complete';
    if (!remote && sess.sources.throttled) return 'partial';                                  // peers are healthy but we are pacing ourselves
    if (!remote) return sess.items.size ? 'local_only' : 'offline';
    if (sess.sources.ok === 0) return sess.sources.throttled && !sess.sources.failed ? 'partial' : 'degraded';
    const lost = sess.sources.failed + sess.sources.skipped_open + sess.sources.throttled, asked = sess.sources.queried + sess.sources.skipped_open + sess.sources.throttled;
    return lost > 0 && lost >= Math.max(1, Math.ceil(asked * 0.25)) ? 'partial' : 'complete';   // one slow Hub among many is normal, not a degraded search
  }

  // ------------------------------------------------------------------ the staged run
  async _run(sess, params) {
    let analysis = ST.analyzeQuery(sess.q, { languages: sess.langs });
    if (this.translator && sess.q) analysis = await ST.translateExpand(analysis, this.translator, sess.langs);
    sess.analysis = analysis;
    sess.ctx = { analysis, weights: this.cfg.weights, now: Date.now(), langs: sess.filters.language ? [sess.filters.language] : (sess.langs.length ? sess.langs : (analysis.lang !== 'und' ? [analysis.lang] : [])), region: sess.filters.region || this.profile.region };
    const strict = !!(sess.filters.language || sess.filters.region || sess.filters.topic);
    const filt = { language: sess.filters.language || undefined, region: sess.filters.region || undefined, topic: sess.filters.topic || undefined, strict };

    // Stage 0 — local index (own documents + any shard replicas): immediate, no network.
    this._stage(sess, 'local', 'running');
    try {
      const rows = sess.mode === 'search' ? this.index.searchWeighted(analysis.terms, { limit: 50, ...filt }) : this.index.recentDocuments({ limit: 50, ...filt });
      let n = 0; for (const r of rows) if (this._add(sess, r, 'self', true)) n++;
      this._stage(sess, 'local', 'done', { items: n });
    } catch (e) { this._stage(sess, 'local', 'failed'); }
    if (sess.scope === 'local' || sess.cancel) { for (const st of sess.stages) if (st.state === 'pending') st.state = 'skipped'; return; }

    const pool = this._pool(sess);
    const assigned = new Set(); const take = (pred) => pool.filter((p) => !assigned.has(p.peer_id) && pred(p)).map((p) => { assigned.add(p.peer_id); return p; });
    const region = sess.filters.region || this.profile.region;
    const langTargets = new Set([...(sess.filters.language ? [sess.filters.language] : sess.langs), ...(analysis.lang !== 'und' ? [analysis.lang] : [])]);
    const plan = {
      regional: region ? take((p) => p.region === region) : [],
      language: take((p) => (p.languages || []).some((l) => langTargets.has(l))),
      topic: take((p) => (p.topics || []).some((t) => analysis.topics.includes(t) || t === sess.filters.topic)),
    };
    plan.global = take(() => true);
    let budget = this.cfg.maxPeers; const deadline = this.now() + this.cfg.totalTimeoutMs;
    for (const stage of ['regional', 'language', 'topic', 'global']) {
      if (sess.cancel) break;
      const cands = this._order(plan[stage], sess);
      if (!cands.length) { this._stage(sess, stage, 'skipped', { reason: 'no_peers' }); continue; }
      if (this.now() >= deadline) { this._stage(sess, stage, 'skipped', { reason: 'timeout' }); continue; }
      if (budget <= 0) { this._stage(sess, stage, 'skipped', { reason: 'budget' }); continue; }
      if (sess.scope !== 'global' && this._satisfied(sess)) { this._stage(sess, stage, 'skipped', { reason: 'satisfied' }); continue; }
      const r = await this._runStage(sess, stage, cands, budget, Math.min(this.cfg.stageTimeoutMs, Math.max(200, deadline - this.now())), filt);
      budget -= r.used;
      if (stage !== 'global' && r.leftover.length) plan.global = [...r.leftover, ...plan.global];      // peers skipped by this stage's fan-out cap are NOT forgotten
    }
  }

  _pool(sess) {
    const out = []; const seen = new Set([this.self]);
    for (const p of (this.peers() || [])) {
      if (out.length >= this.cfg.maxPool) break;                       // planning cost is bounded no matter how many peers the provider knows
      if (!p || typeof p.peer_id !== 'string' || !PEER_RE.test(p.peer_id) || seen.has(p.peer_id)) continue;
      seen.add(p.peer_id);
      if (this.trust) { const s = this.trust.stateOf(p.peer_id); if (s === 'BLOCKED' || s === 'QUARANTINED') continue; }
      if (this._isOpen(p.peer_id)) { sess.sources.skipped_open++; this.metrics.breaker_skips++; continue; }
      if (this._isThrottled(p.peer_id)) { sess.sources.throttled++; continue; }
      out.push({ peer_id: p.peer_id, region: String(p.region || 'ZZ').toUpperCase().slice(0, 2), languages: (p.languages || []).map(String).slice(0, 8), topics: (p.topics || []).map(String).slice(0, 16) });
    }
    return out;
  }
  /** Deterministic per-query spread (so load is distributed) biased toward fast, healthy peers. */
  _order(list, sess) {
    return list.map((p) => { const h = this._h(p.peer_id); const spread = parseInt(sha256(sess.key + p.peer_id).slice(0, 6), 16) / 0xffffff; return { p, s: spread - (h.lat ? Math.min(0.4, h.lat / 10000) : 0) + (h.ok > 3 ? 0.05 : 0) }; })
      .sort((a, b) => b.s - a.s || (a.p.peer_id < b.p.peer_id ? -1 : 1)).map((x) => x.p);
  }
  _satisfied(sess) {
    const items = [...sess.items.values()]; const origins = new Set(items.map((i) => i.origin_peer)), regions = new Set(items.map((i) => i.region));
    return items.length >= sess.want && origins.size >= Math.min(3, sess.want) && regions.size >= 2;
  }
  _stage(sess, name, state, extra = {}) { const st = sess.stages.find((x) => x.stage === name); Object.assign(st, { state }, extra); sess.version++; }

  async _runStage(sess, stage, cands, budget, timeoutMs, filt) {
    this._stage(sess, stage, 'running');
    const st = sess.stages.find((x) => x.stage === stage);
    const fan = Math.max(1, Math.min(this.cfg.fanout, budget, this.governor ? Math.max(2, this.governor.concurrency()) : this.cfg.fanout));
    const queue = cands.slice(); let used = 0;
    const msg = sess.mode === 'search'
      ? { t: 'search', terms: sess.analysis.terms.slice(0, 24), limit: this.cfg.perPeerLimit, language: filt.language, region: filt.region, topic: filt.topic, strict: filt.strict }
      : { t: 'browse', limit: this.cfg.perPeerLimit, language: filt.language, region: filt.region, topic: filt.topic, strict: filt.strict };
    const stageDeadline = this.now() + timeoutMs;
    const askOne = async (peer) => {
      const inflight = this._inflight.get(peer.peer_id) || 0;
      if (inflight >= this.cfg.perPeerInflight) { sess.sources.throttled++; return false; }          // admission control: never self-DoS a healthy peer
      this._inflight.set(peer.peer_id, inflight + 1);
      used++; st.peers++; sess.sources.queried++; this.metrics.requests++;
      const t0 = this.now();
      try {
        const left = Math.max(100, stageDeadline - this.now());
        const resp = await withTimeout(this.transport.request(peer.peer_id, msg, { timeoutMs: left }), left);
        if (!resp || resp.ok !== true || !Array.isArray(resp.items)) throw new Error(resp && resp.reason ? 'remote_' + resp.reason : 'bad_response');
        this._good(peer.peer_id, this.now() - t0); st.ok++; sess.sources.ok++;
        let acc = 0, bad = 0;
        for (const raw of resp.items.slice(0, this.cfg.perPeerLimit)) { const r = await this._addRemote(sess, peer.peer_id, raw); if (r === true) acc++; else if (r === 'invalid') bad++; }
        st.items += acc; sess.version++;
        if (bad) { sess.sources.rejected_items += bad; this.metrics.rejected_items += bad; if (this.trust) { try { this.trust.observe(peer.peer_id, { abuse: 1 }); } catch { /* ignore */ } } }
        else if (this.trust) { try { this.trust.observe(peer.peer_id, { success: true }); } catch { /* ignore */ } }
        return true;
      } catch (e) {
        if (/^remote_(rate_limited|busy)$/.test(String(e && e.message))) { this._throttle(peer.peer_id); sess.sources.throttled++; sess.sources.queried--; this.metrics.throttled = (this.metrics.throttled || 0) + 1; return false; }
        this._bad(peer.peer_id); st.failed++; sess.sources.failed++; this.metrics.failures++; return false;
      } finally { this._inflight.set(peer.peer_id, Math.max(0, (this._inflight.get(peer.peer_id) || 1) - 1)); }
    };
    // A stage asks at most `fan` peers, plus one replacement per failure (bounded by cfg.replacements) — never the whole candidate list.
    const cap = () => Math.min(budget, fan + Math.min(st.failed, this.cfg.replacements));
    const worker = async () => {
      for (;;) {
        if (sess.cancel || this.now() >= stageDeadline || used >= cap()) return;
        const peer = queue.shift(); if (!peer) return;
        await askOne(peer);
      }
    };
    await Promise.all(Array.from({ length: Math.min(fan, queue.length) }, () => worker()));
    this._stage(sess, stage, st.ok || !st.peers ? 'done' : 'failed');
    return { used, leftover: queue };
  }

  // ------------------------------------------------------------------ result intake (verify -> filter -> rank)
  async _addRemote(sess, servedBy, raw) {
    const it = this._shape(raw); if (!it) return 'invalid';
    const memo = it.origin_peer + '\t' + it.content_id + '\t' + it.content_hash + '\t' + it.origin_sig;
    if (!sess.verified.has(memo)) {
      if (sha256(it.title + '\n' + it.text) !== it.content_hash) return 'invalid';
      let ok = false; try { ok = await this.signer.verify(C.docPayload(it), it.origin_sig, it.origin_peer); } catch { ok = false; }
      if (!ok) return 'invalid';
      sess.verified.set(memo, true);
    }
    return this._add(sess, it, servedBy, false) ? true : false;
  }
  _shape(r) {
    if (!r || typeof r !== 'object') return null;
    const origin = String(r.origin_peer || ''), id = String(r.content_id || '');
    if (!PEER_RE.test(origin) || !id || id.length > 160) return null;
    if (typeof r.origin_sig !== 'string' || r.origin_sig.length < 20 || r.origin_sig.length > 200) return null;
    if (!HEX64.test(String(r.content_hash || ''))) return null;
    const upd = Number(r.updated_at); if (!Number.isFinite(upd) || upd < Date.UTC(2020, 0, 1) || upd > Date.now() + 600000) return null;   // far-future dates would game freshness
    const lang = String(r.language || 'und'); if (!/^([a-z]{2,3}|und)$/.test(lang)) return null;
    const region = String(r.region || 'ZZ').toUpperCase(); if (!/^[A-Z]{2}$/.test(region)) return null;
    const topics = (Array.isArray(r.topics) ? r.topics : []).slice(0, 12).map((x) => clip(x, 40));
    return { origin_peer: origin, content_id: id, title: clip(r.title, 300), text: clip(r.text, 12000), language: lang, region, topics, content_hash: String(r.content_hash), updated_at: Math.floor(upd), origin_sig: r.origin_sig };
  }
  _add(sess, raw, servedBy, trusted) {
    const it = trusted ? { ...raw, topics: raw.topics || [] } : raw;
    const rel = RK.relevance(sess.analysis, it);
    if (sess.mode === 'search' && rel < this.cfg.minRelevance) return false;
    const key = it.origin_peer + '\t' + it.content_id; const cur = sess.items.get(key);
    if (cur && cur.updated_at > it.updated_at) { if (!cur.served_by.includes(servedBy)) cur.served_by.push(servedBy); return false; }
    const { parts, base } = RK.baseScore(it, { ...sess.ctx, rel: () => rel });
    const served = cur ? [...new Set([...cur.served_by, servedBy])] : [servedBy];
    if (servedBy !== 'self') { const hk = it.origin_peer + '\t' + it.content_id; const set = this._holders.get(hk) || new Set(); set.add(servedBy); this._holders.set(hk, set); if (this._holders.size > 2000) this._holders.delete(this._holders.keys().next().value); }
    sess.items.set(key, { ...it, served_by: served, parts, base });
    return !cur || cur.content_hash !== it.content_hash;
  }

  // ------------------------------------------------------------------ progressive read + pagination
  snapshot(id, { offset = 0, limit = 20 } = {}) {
    const s = this._sessions.get(id); if (!s) return null;
    offset = Math.max(0, Number(offset) || 0); limit = Math.max(1, Math.min(50, Number(limit) || 20));
    const deduped = RK.dedupe([...s.items.values()].map((i) => ({ ...i })));
    // Diversity is applied PER PAGE, sequentially: page k is re-ranked from what pages 0..k-1 left over, so no page is dominated by one Hub.
    let pool = deduped.map((i) => ({ item: i, base: i.base, parts: i.parts })); const flat = [];
    while (flat.length < offset + limit && pool.length) {
      const page = RK.rerank(pool, limit, { weights: this.cfg.weights, capPerOrigin: Math.max(2, Math.ceil(limit * 0.3)) });
      if (!page.length) break; flat.push(...page);
      const taken = new Set(page.map((r) => r.item.origin_peer + '\t' + r.item.content_id));
      pool = pool.filter((p) => !taken.has(p.item.origin_peer + '\t' + p.item.content_id));
    }
    const ranked = flat.slice(offset, offset + limit);
    const total = deduped.length;
    const next = offset + ranked.length < total ? RK.encodeCursor({ s: s.id, o: offset + limit, v: s.version }) : null;
    return {
      session: s.id, state: s.state, mode: s.mode, cached: s.cached, version: s.version, took_ms: Date.now() - s.t0, total, next_cursor: next,
      stages: s.stages.map((x) => ({ ...x })), sources: { ...s.sources },
      query: s.analysis ? { lang: s.analysis.lang, topics: s.analysis.topics, expanded: s.analysis.expansions.length > 0, translated: !!s.analysis.translated } : null,
      items: ranked.map((r) => this._out(r.item, r)),
    };
  }
  _out(i, r) {
    const isSelf = i.origin_peer === this.self;
    return { id: sha256(i.origin_peer + ':' + i.content_id).slice(0, 16), origin_ref: i.origin_peer, content_id: i.content_id, hub: { label: isSelf ? 'This Hub' : hubLabel(i.origin_peer, i.region), region: i.region, is_self: isSelf },
      title: i.title, excerpt: i.text.length > 280 ? i.text.slice(0, 277) + '…' : i.text, language: i.language, region: i.region, topics: i.topics, updated_at: i.updated_at, content_hash: i.content_hash,
      score: Math.round(r.score * 1000) / 1000, parts: Object.fromEntries(Object.entries(r.parts).map(([k, v]) => [k, Math.round(v * 100) / 100])), sources: i.served_by.length, duplicates: i.duplicates || 0, verified: true };
  }

  // ------------------------------------------------------------------ full content on demand (origin Hub decides access)
  async fetchContent({ origin_ref, content_id, content_hash = '', force = false }) {
    const origin = String(origin_ref || ''), id = String(content_id || '');
    if (!PEER_RE.test(origin) || !id) return { status: 'bad_request' };
    const key = origin + '\t' + id; let c = this._content.get(key);
    if (this.store && this.store.tombstonedPost && this.store.tombstonedPost(id)) { this._content.delete(key); return { status: 'gone' }; }      // known-deleted: never ask, never show
    if (this.store && this.store.tombstone && c && c.actor && this.store.tombstone(c.actor, id)) { this._content.delete(key); return { status: 'gone' }; }
    if (!c && this.store && this.store.cachedPost) {          // durable cache (survives restarts): rebuild the projection from verified, signed events
      const cp = this.store.cachedPost(id);
      if (cp && cp.gone) return { status: 'gone' };
      if (cp && cp.events) { const post = projectPost(cp.events, id); if (post && !post.gone) { c = { at: this.now() - Math.max(0, Date.now() - (cp.fetched_at || 0)), post, hash: sha256('\n' + post.content), actor: post.actor_id }; this._content.set(key, c); } }
    }
    if (!force && c && this.now() - c.at < this.cfg.contentTtlMs) return { status: 'ok', cached: true, post: c.post, stale_index: !!(content_hash && c.hash && content_hash !== c.hash) };
    let resp; this.metrics.content_requests++;
    try {
      if (origin === this.self) resp = this.localContent ? await this.localContent(id, { have_hash: c ? c.hash : '' }) : { status: 'not_found' };
      else if (this._isOpen(origin)) throw Object.assign(new Error('open'), { code: 'E_OPEN' });
      else { const t0 = this.now(); resp = await withTimeout(this.transport.request(origin, { t: 'content', content_id: id, have_hash: c ? c.hash : '' }, { timeoutMs: this.cfg.stageTimeoutMs }), this.cfg.stageTimeoutMs); this._good(origin, this.now() - t0); }
    } catch (e) {
      if (e.code !== 'E_OPEN') this._bad(origin);
      return await this._viaReplica(key, origin, id, c, content_hash);
    }
    if (!resp || resp.ok === false) return { status: 'unavailable' };
    if (resp.status === 'unchanged' && c) { c.at = this.now(); this.metrics.content_unchanged++; return { status: 'ok', cached: true, unchanged: true, post: c.post }; }
    if (resp.status === 'gone') { this._content.delete(key); if (this.store && this.store.forgetPost) this.store.forgetPost(id, { tombstone: true }); return { status: 'gone' }; }
    if (resp.status !== 'ok' || !Array.isArray(resp.events)) return { status: 'not_found' };
    return this._accept(key, id, resp.events, content_hash, { from_replica: false });
  }
  /** Verify + project + cache signed events (from the origin OR from a replica: the checks are identical). */
  _accept(key, id, events, content_hash, { from_replica }) {
    const created = events.find((e) => e && e.event_id === id && e.event_type === 'post.create');
    if (created && this.store && this.store.tombstone && this.store.tombstone(created.actor_id, id)) { this._content.delete(key); return { status: 'gone' }; }   // checked BEFORE trusting any copy
    let accepted = 0;
    try { accepted = this.verifyEvents ? this.verifyEvents(events.slice(0, 12)) : 0; } catch { accepted = 0; }
    const acceptedN = typeof accepted === 'object' && accepted ? Number(accepted.accepted) || 0 : Number(accepted) || 0;
    if (!acceptedN) return { status: 'rejected' };
    const post = projectPost(events, id);
    if (!post) return { status: 'not_found' };
    if (post.gone) { this._content.delete(key); return { status: 'gone' }; }
    if (this.store && this.store.tombstone && this.store.tombstone(post.actor_id, id)) { this._content.delete(key); return { status: 'gone' };          }   // a replica can never resurrect a deleted post
    const hash = sha256('\n' + post.content);
    this._content.set(key, { at: this.now(), post, hash, actor: post.actor_id });
    while (this._content.size > this.cfg.contentCacheMax) this._content.delete(this._content.keys().next().value);
    if (from_replica) this.metrics.content_replica++; else this.metrics.content_refreshed++;
    return { status: 'ok', post, stale_index: !!(content_hash && content_hash !== hash), ...(from_replica ? { from_replica: true, may_be_stale: true } : {}) };
  }
  /** Origin unreachable: try up to two holders that served this document in a search (valid replicas), else fall back to the stale cache. */
  async _viaReplica(key, origin, id, c, content_hash) {
    for (const holder of [...(this._holders.get(key) || [])].filter((h) => h !== origin && !this._isOpen(h)).slice(0, 2)) {
      try {
        const resp = await withTimeout(this.transport.request(holder, { t: 'content', content_id: id, have_hash: '', replica_ok: true }, { timeoutMs: this.cfg.stageTimeoutMs }), this.cfg.stageTimeoutMs);
        if (resp && resp.ok && resp.status === 'ok' && resp.replica === true && Array.isArray(resp.events)) { this._good(holder, 1); const r = this._accept(key, id, resp.events, content_hash, { from_replica: true }); if (r.status === 'ok' || r.status === 'gone') return r; }
      } catch { this._bad(holder); }
    }
    return c ? { status: 'origin_offline', cached: true, post: c.post } : { status: 'origin_offline' };
  }
  /** Background refresh: entries past half their TTL are revalidated by hash (nothing is downloaded when unchanged). */
  async revalidate({ max = 10 } = {}) {
    const out = { checked: 0, unchanged: 0, updated: 0, gone: 0, offline: 0 }; const half = this.cfg.contentTtlMs / 2; const t = this.now();
    const due = [...this._content.entries()].filter(([, v]) => t - v.at >= half).sort((a, b) => a[1].at - b[1].at).slice(0, max);
    for (const [key, v] of due) {
      const [origin, id] = key.split('\t'); out.checked++; const before = v.hash; const r = await this.fetchContent({ origin_ref: origin, content_id: id, force: true });
      if (r.unchanged) out.unchanged++; else if (r.status === 'gone') out.gone++; else if (r.status === 'ok' && !r.cached) { if (r.post && sha256('\n' + r.post.content) !== before) out.updated++; else out.unchanged++; } else out.offline++;
    }
    return out;
  }
}

module.exports = { SearchService, FederatedSearch, projectPost, hubLabel, DEFAULTS, STAGES, MSG_TYPES };
