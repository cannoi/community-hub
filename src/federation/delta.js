'use strict';
/**
 * Phase 7 — anti-entropy for the ledger delta sync.
 *
 * The normal sync is a cursor over the PEER's local insertion id. That is exact while the peer's database is intact, but a peer that
 * was restored from a backup (or lost rows) can hand out new events with ids at/below our cursor; we would never ask for them again.
 * Every `intervalMs` (and right after a peer comes back from offline) we therefore compare compact HEADS — (actor, last sequence,
 * last event id) — for the actors we ALREADY replicate. Cost: a few hundred bytes per actor, paged and time-boxed; no content is
 * transferred unless a head proves we are missing something.
 *   peer ahead of us            -> fetch exactly the missing range (existing fillGap)
 *   same sequence, different id -> fork: fetch their event; the ledger verifies it and records a proper sequence_fork conflict
 *   peer behind us              -> informational (it will catch up from us through its own sync)
 * Actors we do not replicate are ignored, so this can never widen what a Hub stores.
 */
const { isAccountId } = require('../keystore');
const { EVENT_ID_RE } = require('../ledger');

function recordFinding(db, { layer, subject, kind, severity = 'warn', detail = {} }) {
  try { db.run('INSERT OR IGNORE INTO integrity_findings(layer,subject,kind,severity,detail,status,detected_at) VALUES(?,?,?,?,?,?,?)', layer, String(subject).slice(0, 200), kind, severity, JSON.stringify(detail).slice(0, 2000), 'open', Date.now()); } catch { /* table absent on pre-migration DBs */ }
}

class AntiEntropy {
  constructor({ peers, ledger, db, log, intervalMs = 600000, maxActorsPerRun = 20, maxPages = 5, now = Date.now }) {
    Object.assign(this, { peers, ledger, db, intervalMs, maxActorsPerRun, maxPages, now });
    this.log = log || { debug() {}, warn() {} }; this._last = new Map();
    this.stats = { runs: 0, checked: 0, missing: 0, repaired: 0, forks: 0, behind: 0, errors: 0 };
  }
  due(peerId) { const t = this._last.get(peerId) || 0; return this.now() - t >= this.intervalMs * (0.8 + Math.random() * 0.4); }
  /** Rate-limited entry used by the sync loop. Never throws. */
  async maybeRun(peer, { force = false } = {}) {
    if (!peer || (!force && !this.due(peer.id))) return null;
    this._last.set(peer.id, this.now());
    try { return await this.run(peer); } catch (e) { this.stats.errors++; this.log.debug('anti-entropy: ' + (e.code || e.message)); return null; }
  }
  async run(peer) {
    this.stats.runs++; const out = { checked: 0, missing: 0, repaired: 0, forks: 0, behind: 0 }; const miss = new Map(); let after = '';
    for (let page = 0; page < this.maxPages; page++) {
      const r = await this.peers.call(peer, 'GET', `/federation/v1/heads?limit=100${after ? '&after=' + after : ''}`, { maxBytes: 256 * 1024 });
      if (!Array.isArray(r.heads) || r.heads.length > 200) throw Object.assign(new Error('bad_heads'), { code: 'bad_heads' });
      for (const h of r.heads) {
        if (!h || !isAccountId(h.actor) || !Number.isSafeInteger(h.seq) || h.seq < 1 || typeof h.id !== 'string' || !EVENT_ID_RE.test(h.id)) continue;
        const st = this.ledger.actorState(h.actor); if (!st) continue;                 // outside our interest scope: never widen it
        out.checked++;
        if (h.seq > st.last_seq) { if (miss.size < this.maxActorsPerRun) miss.set(h.actor, { from: st.last_seq + 1 }); out.missing++; }
        else if (h.seq === st.last_seq && h.id !== st.last_event_id) { out.forks++; await this._fork(peer, h, st); }
        else if (h.seq < st.last_seq) out.behind++;
      }
      if (!r.has_more || typeof r.next !== 'string') break; after = r.next;
    }
    for (const [actor, m] of miss) {
      const before = (this.ledger.actorState(actor) || {}).last_seq || 0; const stats = { accepted: 0 };
      try { await this.peers.fillGap(peer, actor, m.from, stats); } catch (e) { this.log.debug('anti-entropy fill: ' + (e.code || e.message)); }
      if (((this.ledger.actorState(actor) || {}).last_seq || 0) > before) out.repaired++;
    }
    Object.assign(this.stats, { checked: this.stats.checked + out.checked, missing: this.stats.missing + out.missing, repaired: this.stats.repaired + out.repaired, forks: this.stats.forks + out.forks, behind: this.stats.behind + out.behind });
    return out;
  }
  async _fork(peer, h, st) {
    recordFinding(this.db, { layer: 'ledger', subject: h.actor + '#' + h.seq, kind: 'head_mismatch', severity: 'warn', detail: { ours: st.last_event_id, theirs: h.id, seq: h.seq, peer: peer.account_id } });
    try {   // let the ledger itself judge: a validly signed different event at the same sequence is recorded as sequence_fork
      const r = await this.peers.call(peer, 'GET', `/federation/v1/events/actor/${h.actor}?from=${h.seq}&limit=1`, { maxBytes: 64 * 1024 });
      if (Array.isArray(r.events) && r.events.length) this.ledger.ingestBatch(r.events.slice(0, 1), { source: 'peer:' + peer.account_id });
    } catch { /* best effort */ }
  }
}
module.exports = { AntiEntropy, recordFinding };
