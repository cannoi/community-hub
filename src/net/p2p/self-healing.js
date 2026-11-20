'use strict';
/**
 * Phase 7 — data-plane self-healing.
 *
 * Complements SelfHealEngine (Phase 2, connectivity). This supervisor audits the DATA a Hub depends on, records every finding
 * durably (`integrity_findings`) and repairs it automatically without an operator:
 *
 *   layer         detects                                         heals by
 *   ledger        event rows that fail signature / chain checks   fetching the same (actor,sequence) from a peer, verifying it,
 *                                                                 swapping it in; the corrupt row is KEPT in events_quarantine
 *   view          posts table disagreeing with the ledger         ledger.reindex() (derived tables only, digest-checked)
 *   index         search-index documents disagreeing with posts   re-index / drop that document (derived data)
 *   remote_cache  cached events failing verification / resurrected  dropping the cached rows (derived data)
 *   sync          gaps that stayed open                           filling the gap through a DIFFERENT healthy peer
 *   peer          a peer whose events are mostly rejected         pausing content sync with it for a cool-down (reversible)
 *
 * Rules (enforced + tested): original data (ledger events, media, keys) is never deleted; healers flagged `guard` must leave the
 * ledger fingerprint unchanged or they are disabled; retries use exponential back-off with full jitter AND a global retry budget so
 * a broken network can never cause a retry storm; every cycle is time-boxed and cycles never overlap.
 */
const { verifyEnvelope } = require('../../ledger');

class Backoff {
  constructor({ baseMs = 5000, maxMs = 900000, now = Date.now, rand = Math.random } = {}) { Object.assign(this, { baseMs, maxMs, now, rand }); this.m = new Map(); }
  fail(key) { const n = ((this.m.get(key) || {}).n || 0) + 1; const d = Math.min(this.maxMs, this.baseMs * 2 ** (n - 1)) * (0.5 + this.rand() * 0.5); this.m.set(key, { n, until: this.now() + d }); if (this.m.size > 5000) this.m.delete(this.m.keys().next().value); return d; }
  ok(key) { this.m.delete(key); }
  ready(key) { const e = this.m.get(key); return !e || e.until <= this.now(); }
  attempts(key) { return (this.m.get(key) || {}).n || 0; }
}
class RetryBudget {
  constructor({ capacity = 20, refillPerMin = 20, now = Date.now } = {}) { Object.assign(this, { capacity, refillPerMin, now }); this.tokens = capacity; this.t = now(); }
  take(n = 1) { const t = this.now(); this.tokens = Math.min(this.capacity, this.tokens + ((t - this.t) / 60000) * this.refillPerMin); this.t = t; if (this.tokens < n) return false; this.tokens -= n; return true; }
}
const DEFAULTS = { cycleBudgetMs: 250, maxHealPerCycle: 5, auditBatch: 200, auditIntervalMs: 6 * 3600000, viewSample: 50, cacheSample: 200, gapStaleMs: 300000,
  abuseMinRejected: 10, abuseRatio: 0.5, quarantineMs: 3600000, maxAttempts: 8, reindexCooldownMs: 3600000, backoffBaseMs: 5000, backoffMaxMs: 900000, retryCapacity: 20, retryPerMin: 20 };

class HealingSupervisor {
  /** @param {{db:object, ledger:object, peers?:object, remote?:object, indexer?:object, net?:object, log?:object, now?:function, rand?:function, cfg?:object}} o */
  constructor(o) {
    Object.assign(this, { db: o.db, ledger: o.ledger, peers: o.peers || null, remote: o.remote || null, indexer: o.indexer || null, net: o.net || null });
    this.log = o.log || { debug() {}, info() {}, warn() {}, error() {} }; this.now = o.now || Date.now; this.cfg = { ...DEFAULTS, ...(o.cfg || {}) };
    this.backoff = new Backoff({ baseMs: this.cfg.backoffBaseMs, maxMs: this.cfg.backoffMaxMs, now: this.now, rand: o.rand });
    this.budget = new RetryBudget({ capacity: this.cfg.retryCapacity, refillPerMin: this.cfg.retryPerMin, now: this.now });
    this._running = false; this._timer = null; this._rot = 0; this._auditResumeAt = 0; this._lastReindex = 0; this._peerSnap = new Map();
    this.metrics = { cycles: 0, detected: 0, repaired: 0, failed: 0, abandoned: 0, skipped_budget: 0, guard_violations: 0, last_cycle_ms: 0, last_cycle_at: 0 };
    this.detectors = [];
    this._builtins();
  }
  attachIndexer(indexer) { this.indexer = indexer; return this; }
  register(det) { this.detectors.push({ guard: false, ...det }); return this; }

  // ------------------------------------------------------------------ persistence helpers
  _meta(k) { try { const r = this.db.get('SELECT value FROM meta WHERE key=?', k); return r ? r.value : undefined; } catch { return undefined; } }
  _setMeta(k, v) { this.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', k, String(v)); }
  _record(layer, f) {
    const r = this.db.run('INSERT OR IGNORE INTO integrity_findings(layer,subject,kind,severity,detail,status,detected_at) VALUES(?,?,?,?,?,?,?)', layer, String(f.subject).slice(0, 200), f.kind, f.severity || 'warn', JSON.stringify(f.detail || {}).slice(0, 2000), 'open', this.now());
    return Number(r.changes || 0) > 0;
  }
  findings({ status = null, limit = 100 } = {}) {
    return this.db.all(`SELECT * FROM integrity_findings ${status ? 'WHERE status=?' : ''} ORDER BY id DESC LIMIT ?`, ...(status ? [status, limit] : [limit])).map((r) => ({ ...r, detail: (() => { try { return JSON.parse(r.detail); } catch { return {}; } })() }));
  }
  _fp() { const r = this.db.get('SELECT COUNT(*) c, COALESCE(MAX(lid),0) m, COALESCE(SUM(LENGTH(body)),0) s FROM events'); return `${r.c}:${r.m}:${r.s}`; }

  // ------------------------------------------------------------------ the cycle
  /** One bounded pass: detect, then heal a few findings. Never throws, never overlaps. */
  async cycle() {
    if (this._running) return { skipped: true };
    this._running = true; const t0 = Date.now(); const rep = { detected: 0, repaired: 0, failed: 0, skipped: 0 };
    try {
      const n = this.detectors.length;
      for (let i = 0; i < n; i++) {
        if (Date.now() - t0 > this.cfg.cycleBudgetMs && i > 0) break;
        const det = this.detectors[(this._rot + i) % n]; if (det.disabled) continue;
        const key = 'det:' + det.name; if (!this.backoff.ready(key)) continue;
        try { const found = await det.detect(); this.backoff.ok(key); for (const f of found || []) if (this._record(det.layer, f)) { rep.detected++; this.metrics.detected++; } }
        catch (e) { this.backoff.fail(key); this.log.warn(`healing detector ${det.name}: ${e && e.message}`); }
      }
      this._rot = (this._rot + 1) % Math.max(1, n);
      const open = this.db.all("SELECT * FROM integrity_findings WHERE status='open' ORDER BY (severity='critical') DESC, id ASC LIMIT ?", this.cfg.maxHealPerCycle * 4);
      let healed = 0;
      for (const f of open) {
        if (healed >= this.cfg.maxHealPerCycle || (Date.now() - t0 > this.cfg.cycleBudgetMs * 4)) break;
        const det = this.detectors.find((d) => !d.disabled && d.layer === f.layer && (d.kinds || []).includes(f.kind)); if (!det) continue;
        const key = 'f:' + f.id; if (!this.backoff.ready(key)) { rep.skipped++; continue; }
        if (!this.budget.take()) { this.metrics.skipped_budget++; rep.skipped++; break; }            // global retry budget: no storms
        healed++; await this._heal(det, f, rep);
      }
    } finally { this._running = false; this.metrics.cycles++; this.metrics.last_cycle_ms = Date.now() - t0; this.metrics.last_cycle_at = this.now(); }
    return rep;
  }
  async _heal(det, f, rep) {
    const key = 'f:' + f.id; let res = { repaired: false };
    const before = det.guard ? this._fp() : null;
    try { res = (await det.heal({ ...f, detail: (() => { try { return JSON.parse(f.detail); } catch { return {}; } })() })) || { repaired: false }; }
    catch (e) { res = { repaired: false, detail: String(e && e.message).slice(0, 200) }; }
    if (det.guard && this._fp() !== before) {       // a "derived-only" healer touched the original data: stop it for good and say so loudly
      det.disabled = true; this.metrics.guard_violations++; this.log.error(`healing: ${det.name} changed original data; healer disabled`);
      this._record('healing', { subject: det.name, kind: 'originals_changed', severity: 'critical', detail: { finding: f.id } });
    }
    if (res.repaired) { this.db.run("UPDATE integrity_findings SET status='repaired', repaired_at=?, attempts=attempts+1, last_attempt_at=? WHERE id=?", this.now(), this.now(), f.id); this.backoff.ok(key); this.metrics.repaired++; rep.repaired++; return; }
    const attempts = (f.attempts || 0) + 1; const abandon = attempts >= this.cfg.maxAttempts;
    this.db.run('UPDATE integrity_findings SET attempts=?, last_attempt_at=?, status=? WHERE id=?', attempts, this.now(), abandon ? 'abandoned' : 'open', f.id);
    this.backoff.fail(key); this.metrics.failed++; rep.failed++; if (abandon) this.metrics.abandoned++;
  }
  start({ intervalMs = 60000 } = {}) { this.stop(); this._timer = setInterval(() => { this.cycle().catch(() => {}); }, intervalMs); if (this._timer.unref) this._timer.unref(); }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; }

  // ------------------------------------------------------------------ lifecycle + aggregate status
  /** discovered → authenticated → syncing → synced; degraded / offline. "synced" is never claimed without a successful sync. */
  lifecycle(p) {
    if (!this.peers) return 'discovered';
    if (p.state === 'blocked') return 'offline';
    if (!p.last_ok) return p.fail_streak > 0 ? 'offline' : 'discovered';
    if (p.fail_streak >= 3) return 'offline';
    if (p.fail_streak > 0) return 'degraded';
    if (this.peers.inflight && this.peers.inflight.has(p.id)) return 'syncing';
    if (!this.peers.syncAllowed(p)) return 'authenticated';
    return this.db.get('SELECT 1 x FROM ledger_gaps LIMIT 1') ? 'syncing' : 'synced';
  }
  status() {
    const peers = this.peers ? this.peers.list() : []; const by = {};
    for (const p of peers) { const s = this.lifecycle(p); by[s] = (by[s] || 0) + 1; }
    const gaps = this.db.get('SELECT COUNT(*) c FROM ledger_gaps').c;
    const f = Object.fromEntries(this.db.all('SELECT status, COUNT(*) c FROM integrity_findings GROUP BY status').map((r) => [r.status, r.c]));
    const crit = this.db.get("SELECT COUNT(*) c FROM integrity_findings WHERE status!='repaired' AND severity='critical'").c;
    const quarantined = this.db.get("SELECT COUNT(*) c FROM meta WHERE key LIKE 'heal.quarantine.%'").c;
    let state = 'synced';
    if (!peers.length) state = 'standalone';
    else if (!(by.synced || by.syncing || by.authenticated || by.degraded)) state = 'offline';
    else if (crit || f.abandoned) state = 'degraded';
    else if (gaps || by.syncing) state = 'syncing';
    else if (by.degraded && !by.synced) state = 'degraded';
    else if (quarantined && !by.synced) state = 'degraded';          // every healthy path is paused: say so instead of claiming Synced
    return { state, peers: by, quarantined_peers: quarantined, backlog: { gaps }, findings: { open: f.open || 0, repaired: f.repaired || 0, abandoned: f.abandoned || 0, critical_unresolved: crit }, metrics: { ...this.metrics },
      detectors: this.detectors.map((d) => ({ name: d.name, layer: d.layer, disabled: !!d.disabled })), index_replication: this.net && this.net.indexReplicationStatus ? this.net.indexReplicationStatus() : undefined };
  }

  // ------------------------------------------------------------------ built-in detectors / healers
  _builtins() {
    // ---- ledger: signature + chain audit, incremental and resumable
    this.register({ name: 'ledger_audit', layer: 'ledger', kinds: ['event_corrupt'],
      detect: async () => {
        if (this.now() < this._auditResumeAt) return [];
        const cur = Number(this._meta('heal.audit_lid') || 0); const out = [];
        const rows = this.db.all('SELECT lid,event_id,actor_id,sequence,body FROM events WHERE lid>? ORDER BY lid LIMIT ?', cur, this.cfg.auditBatch);
        for (const r of rows) {
          let problem = null;
          try {
            const ev = JSON.parse(r.body);
            if (ev.event_id !== r.event_id || ev.actor_id !== r.actor_id || ev.sequence !== r.sequence) problem = 'row_mismatch';
            else {
              verifyEnvelope(ev, this.now());
              if (r.sequence > 1) { const prev = this.db.get('SELECT event_id FROM events WHERE actor_id=? AND sequence=?', r.actor_id, r.sequence - 1); if (!prev || prev.event_id !== ev.previous_event_hash) problem = 'chain_broken'; }
            }
          } catch (e) { problem = e.code || 'unreadable'; }
          if (problem) out.push({ subject: `${r.actor_id}#${r.sequence}`, kind: 'event_corrupt', severity: 'critical', detail: { lid: r.lid, event_id: r.event_id, actor: r.actor_id, seq: r.sequence, problem } });
        }
        if (rows.length < this.cfg.auditBatch) { this._setMeta('heal.audit_lid', 0); this._auditResumeAt = this.now() + this.cfg.auditIntervalMs; } else this._setMeta('heal.audit_lid', rows[rows.length - 1].lid);
        return out;
      },
      heal: (f) => this._repairEvent(f) });

    // ---- view: materialized tables vs the ledger (sampled, rolling)
    this.register({ name: 'view_audit', layer: 'view', kinds: ['view_diverged'], guard: true,
      detect: async () => {
        const cur = Number(this._meta('heal.view_post') || 0); const out = [];
        const rows = this.db.all('SELECT id,event_id FROM posts WHERE event_id IS NOT NULL AND id>? ORDER BY id LIMIT ?', cur, this.cfg.viewSample);
        for (const r of rows) { const why = this._postProblem(r.event_id); if (why) out.push({ subject: r.event_id, kind: 'view_diverged', severity: 'warn', detail: { post: r.id, why } }); }
        this._setMeta('heal.view_post', rows.length < this.cfg.viewSample ? 0 : rows[rows.length - 1].id);
        return out;
      },
      heal: async (f) => {
        if (!this._postProblem(f.subject)) return { repaired: true, detail: 'already consistent' };
        if (this.now() - this._lastReindex < this.cfg.reindexCooldownMs) return { repaired: false, detail: 'reindex cooldown' };
        this._lastReindex = this.now(); this.ledger.reindex();                       // derived tables only; reindex itself verifies the ledger digest is unchanged
        return { repaired: !this._postProblem(f.subject) };
      } });

    // ---- index: search documents vs posts
    this.register({ name: 'index_audit', layer: 'index', kinds: ['stale_doc', 'outdated_doc', 'corrupt_doc'], guard: true,
      detect: async () => (this.indexer && this.indexer.audit ? this.indexer.audit({ limit: this.cfg.auditBatch }) : []),
      heal: async (f) => ({ repaired: !!(this.indexer && this.indexer.repair(f.subject)) }) });

    // ---- discovery cache: verification at rest + tombstone consistency (cache is derived: bad rows are simply dropped)
    this.register({ name: 'cache_audit', layer: 'remote_cache', kinds: ['cache_corrupt', 'resurrected_cache'], guard: true,
      detect: async () => {
        if (!this.remote) return [];
        const cur = Number(this._meta('heal.cache_rowid') || 0); const out = [];
        const rows = this.db.all('SELECT rowid AS rid, event_id, actor_id, event_type, sequence, body FROM remote_cache WHERE rowid>? ORDER BY rowid LIMIT ?', cur, this.cfg.cacheSample);
        for (const r of rows) {
          try {
            const ev = JSON.parse(r.body); if (ev.event_id !== r.event_id) throw new Error('mismatch'); verifyEnvelope(ev, this.now());
            const tgt = r.event_type === 'post.create' ? r.event_id : r.event_type === 'post.edit' ? ev.target : null;
            if (tgt) { const t = this.remote.tombstone(r.actor_id, tgt); if (t && r.sequence < t.deleted_seq) out.push({ subject: r.event_id, kind: 'resurrected_cache', severity: 'warn', detail: { actor: r.actor_id, target: tgt } }); }
          } catch { out.push({ subject: r.event_id, kind: 'cache_corrupt', severity: 'warn', detail: { actor: r.actor_id } }); }
        }
        this._setMeta('heal.cache_rowid', rows.length < this.cfg.cacheSample ? 0 : rows[rows.length - 1].rid);
        return out;
      },
      heal: async (f) => { this.db.run('DELETE FROM remote_cache WHERE event_id=?', f.subject); return { repaired: true }; } });

    // ---- sync backlog: a gap that stays open is retried through a DIFFERENT healthy peer
    this.register({ name: 'sync_backlog', layer: 'sync', kinds: ['gap_stale'],
      detect: async () => this.ledger.openGaps().filter((g) => this.now() - g.detected_at > this.cfg.gapStaleMs).map((g) => ({ subject: g.actor_id, kind: 'gap_stale', severity: 'warn', detail: { expected: g.expected_seq, seen: g.seen_seq, since: g.detected_at } })),
      heal: async (f) => {
        const gap = this.db.get('SELECT expected_seq FROM ledger_gaps WHERE actor_id=?', f.subject); if (!gap) return { repaired: true };
        const tried = new Set((f.detail && f.detail.tried) || []);
        for (const p of this._healthyPeers()) {
          if (tried.has(p.id)) continue;
          try { await this.peers.fillGap(p, f.subject, gap.expected_seq, { accepted: 0 }); } catch { /* next peer */ }
          if (!this.db.get('SELECT 1 x FROM ledger_gaps WHERE actor_id=?', f.subject)) return { repaired: true, detail: 'filled via peer ' + p.id };
          tried.add(p.id); if (tried.size >= 3) break;
        }
        return { repaired: false };
      } });

    // ---- abusive peers: pause content sync for a cool-down (reversible), release when it expires
    this.register({ name: 'peer_abuse', layer: 'peer', kinds: ['peer_abusive'],
      detect: async () => {
        if (!this.peers) return []; const out = []; const now = this.now();
        for (const r of this.db.all("SELECT key, value FROM meta WHERE key LIKE 'heal.quarantine.%'")) {   // release expired quarantines
          if (Number(r.value) <= now) { try { this.peers.setQuarantine(Number(r.key.split('.').pop()), 0); } catch { /* peer removed */ } this.db.run('DELETE FROM meta WHERE key=?', r.key); }
        }
        for (const p of this.peers.list()) {
          if (p.state === 'blocked' || !this.peers.syncAllowed(p)) continue;
          const prev = this._peerSnap.get(p.id); this._peerSnap.set(p.id, { recv: p.events_received, rej: p.events_rejected });
          if (!prev) continue; const dRej = p.events_rejected - prev.rej, dAll = dRej + (p.events_received - prev.recv);
          if (dRej >= this.cfg.abuseMinRejected && dRej / Math.max(1, dAll) >= this.cfg.abuseRatio) out.push({ subject: String(p.id), kind: 'peer_abusive', severity: 'critical', detail: { rejected: dRej, accepted: dAll - dRej } });
        }
        return out;
      },
      heal: async (f) => { this.peers.setQuarantine(Number(f.subject), this.now() + this.cfg.quarantineMs); return { repaired: true }; } });
  }

  _healthyPeers() { return (this.peers ? this.peers.list() : []).filter((p) => p.state !== 'blocked' && this.peers.syncAllowed(p) && !(this.peers.inflight && this.peers.inflight.has(p.id))).sort((a, b) => a.fail_streak - b.fail_streak); }

  /** posts row vs ledger truth; returns a short reason or null. */
  _postProblem(eventId) {
    const post = this.db.get('SELECT content, deleted_at FROM posts WHERE event_id=?', eventId); if (!post) return null;
    const row = this.db.get("SELECT actor_id, body FROM events WHERE event_id=? AND event_type='post.create'", eventId); if (!row) return 'no_event';
    const create = JSON.parse(row.body); let content = create.payload.content, deleted = false;
    for (const r of this.db.all("SELECT body FROM events WHERE actor_id=? AND event_type='post.edit' ORDER BY sequence DESC LIMIT 200", row.actor_id)) { const e = JSON.parse(r.body); if (e.target === eventId) { content = e.payload.content; break; } }
    for (const r of this.db.all("SELECT body FROM events WHERE actor_id=? AND event_type='post.delete' ORDER BY sequence DESC LIMIT 500", row.actor_id)) { if (JSON.parse(r.body).target === eventId) { deleted = true; break; } }
    if (deleted) return post.deleted_at ? null : 'deleted_in_ledger_but_visible';
    if (post.deleted_at) return 'deleted_in_view_only';
    return post.content === content ? null : 'content_differs';
  }

  /** Replace a corrupt event row with a verified copy from a peer; the corrupt original is preserved in events_quarantine. */
  async _repairEvent(f) {
    if (!this.peers) return { repaired: false, detail: 'no peers' };
    const d = f.detail; const row = this.db.get('SELECT * FROM events WHERE lid=?', d.lid); if (!row) return { repaired: true, detail: 'row gone' };
    for (const p of this._healthyPeers().slice(0, 3)) {
      let r; try { r = await this.peers.call(p, 'GET', `/federation/v1/events/actor/${d.actor}?from=${d.seq}&limit=1`, { maxBytes: 64 * 1024 }); } catch { continue; }
      const ev = Array.isArray(r.events) ? r.events[0] : null; if (!ev || ev.actor_id !== d.actor || ev.sequence !== d.seq) continue;
      try { verifyEnvelope(ev, this.now()); } catch { continue; }
      const prev = d.seq > 1 ? this.db.get('SELECT event_id FROM events WHERE actor_id=? AND sequence=?', d.actor, d.seq - 1) : null;
      if (d.seq > 1 && (!prev || prev.event_id !== ev.previous_event_hash)) continue;
      const next = this.db.get('SELECT previous_event_hash FROM events WHERE actor_id=? AND sequence=?', d.actor, d.seq + 1); if (next && next.previous_event_hash !== ev.event_id) continue;
      this.db.tx(() => {
        this.db.run('INSERT INTO events_quarantine(lid,event_id,actor_id,sequence,body,reason,quarantined_at) VALUES(?,?,?,?,?,?,?)', row.lid, row.event_id, row.actor_id, row.sequence, row.body, 'replaced:' + d.problem, this.now());
        this.db.run('UPDATE events SET event_id=?, event_type=?, schema_version=?, previous_event_hash=?, created_at=?, body=? WHERE lid=?', ev.event_id, ev.event_type, ev.schema_version, ev.previous_event_hash, ev.created_at, JSON.stringify(ev), row.lid);
        this.db.run('UPDATE actor_state SET last_event_id=? WHERE actor_id=? AND last_seq=?', ev.event_id, d.actor, d.seq);
      });
      try { this.ledger.reindex(); } catch (e) { this.log.warn('reindex after event repair: ' + e.message); }     // derived tables follow the repaired ledger
      return { repaired: true, detail: 'restored from peer ' + p.id };
    }
    return { repaired: false, detail: 'no peer could supply a valid copy' };
  }
}

module.exports = { HealingSupervisor, Backoff, RetryBudget, DEFAULTS };
