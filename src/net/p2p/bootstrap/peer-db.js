'use strict';
/**
 * Persistent previously-known peer database (Phase 3).
 * Bounded storage; prioritizes recently successful peers.
 * Distinguishes infrastructure vs cannoi categories.
 */
const MAX_PEERS = 500;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

class PeerDatabase {
  /**
   * @param {{ db?: object|null, log?: object, maxPeers?: number }} opts
   */
  constructor(opts = {}) {
    this.db = opts.db || null;
    this.log = opts.log || { debug() {}, info() {}, warn() {} };
    this.maxPeers = opts.maxPeers || MAX_PEERS;
    this._mem = new Map();
  }

  /**
   * @param {import('./types').PeerCandidate & { successCount?: number, failCount?: number }} rec
   */
  upsert(rec) {
    if (!rec || !rec.peerId) return;
    const now = Date.now();
    const prev = this.get(rec.peerId) || {};
    const addrs = new Set([...(prev.multiaddrs || []), ...(rec.multiaddrs || [])].filter(Boolean));
    const row = {
      peer_id: String(rec.peerId).slice(0, 128),
      multiaddrs: [...addrs].slice(0, 16),
      category: rec.category === 'infrastructure' ? 'infrastructure' : 'cannoi',
      source: String(rec.source || prev.source || 'known').slice(0, 32),
      protocol: rec.protocol || prev.protocol || null,
      capabilities: rec.capabilities || prev.capabilities || [],
      expires_at: rec.expiresAt || prev.expires_at || (now + DEFAULT_TTL_MS),
      signature: rec.signature || prev.signature || null,
      last_seen: rec.lastSeen || now,
      last_success: rec.lastSuccess || prev.last_success || 0,
      success_count: (prev.success_count || 0) + (rec.successCount || 0),
      fail_count: (prev.fail_count || 0) + (rec.failCount || 0),
      score: 0,
      updated_at: now,
    };
    row.score = this._score(row);
    this._write(row);
    this._evict();
  }

  markSuccess(peerId) {
    const r = this.get(peerId);
    if (!r) return;
    this.upsert({
      peerId,
      multiaddrs: r.multiaddrs,
      category: r.category,
      source: r.source,
      lastSeen: Date.now(),
      lastSuccess: Date.now(),
      successCount: 1,
    });
  }

  markFailure(peerId) {
    const r = this.get(peerId);
    if (!r) return;
    this.upsert({
      peerId,
      multiaddrs: r.multiaddrs,
      category: r.category,
      source: r.source,
      failCount: 1,
    });
  }

  get(peerId) {
    if (this.db) {
      try {
        const row = this.db.get('SELECT * FROM p2p_peer_db WHERE peer_id=?', peerId);
        return row ? this._fromRow(row) : null;
      } catch { return this._mem.get(peerId) || null; }
    }
    return this._mem.get(peerId) || null;
  }

  /**
   * Candidates ordered by score (recent success first).
   * @param {{ category?: string, limit?: number }} [opts]
   */
  list(opts = {}) {
    const limit = opts.limit || 50;
    const now = Date.now();
    let rows;
    if (this.db) {
      try {
        rows = this.db.all(
          'SELECT * FROM p2p_peer_db WHERE expires_at > ? ORDER BY score DESC, last_success DESC LIMIT ?',
          now, limit * 2
        ).map((r) => this._fromRow(r));
      } catch { rows = [...this._mem.values()]; }
    } else {
      rows = [...this._mem.values()];
    }
    if (opts.category) rows = rows.filter((r) => r.category === opts.category);
    rows = rows.filter((r) => !r.expires_at || r.expires_at > now);
    rows.sort((a, b) => (b.score || 0) - (a.score || 0) || (b.last_success || 0) - (a.last_success || 0));
    return rows.slice(0, limit);
  }

  /** As PeerCandidate[] for bootstrap providers. */
  asCandidates(opts = {}) {
    return this.list(opts).map((r) => ({
      peerId: r.peer_id,
      multiaddrs: r.multiaddrs || [],
      category: r.category,
      source: 'known',
      protocol: r.protocol,
      capabilities: r.capabilities,
      expiresAt: r.expires_at,
      signature: r.signature,
      lastSeen: r.last_seen,
      score: r.score,
    }));
  }

  size() {
    if (this.db) {
      try {
        const r = this.db.get('SELECT COUNT(*) c FROM p2p_peer_db');
        return r ? r.c : 0;
      } catch { return this._mem.size; }
    }
    return this._mem.size;
  }

  clearExpired() {
    const now = Date.now();
    if (this.db) {
      try { this.db.run('DELETE FROM p2p_peer_db WHERE expires_at <= ?', now); } catch { /* ignore */ }
    }
    for (const [id, r] of this._mem) {
      if (r.expires_at && r.expires_at <= now) this._mem.delete(id);
    }
  }

  _score(row) {
    let s = 0;
    s += Math.min(50, (row.success_count || 0) * 5);
    s -= Math.min(30, (row.fail_count || 0) * 3);
    if (row.last_success) {
      const ageH = (Date.now() - row.last_success) / 3600000;
      s += Math.max(0, 40 - ageH);
    }
    if (row.category === 'cannoi') s += 10;
    return Math.round(s);
  }

  _write(row) {
    if (this.db) {
      try {
        this.db.run(
          `INSERT INTO p2p_peer_db(peer_id, multiaddrs, category, source, protocol, capabilities, expires_at, signature, last_seen, last_success, success_count, fail_count, score, updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(peer_id) DO UPDATE SET
             multiaddrs=excluded.multiaddrs, category=excluded.category, source=excluded.source,
             protocol=excluded.protocol, capabilities=excluded.capabilities, expires_at=excluded.expires_at,
             signature=excluded.signature, last_seen=excluded.last_seen, last_success=excluded.last_success,
             success_count=excluded.success_count, fail_count=excluded.fail_count, score=excluded.score, updated_at=excluded.updated_at`,
          row.peer_id,
          JSON.stringify(row.multiaddrs || []),
          row.category,
          row.source,
          row.protocol,
          JSON.stringify(row.capabilities || []),
          row.expires_at,
          row.signature,
          row.last_seen,
          row.last_success || 0,
          row.success_count || 0,
          row.fail_count || 0,
          row.score || 0,
          row.updated_at
        );
        return;
      } catch (e) {
        this.log.debug('peer-db write: ' + (e && e.message));
      }
    }
    this._mem.set(row.peer_id, row);
  }

  _fromRow(row) {
    let multiaddrs = [];
    let capabilities = [];
    try { multiaddrs = JSON.parse(row.multiaddrs || '[]'); } catch { multiaddrs = []; }
    try { capabilities = JSON.parse(row.capabilities || '[]'); } catch { capabilities = []; }
    return {
      peer_id: row.peer_id,
      multiaddrs,
      category: row.category,
      source: row.source,
      protocol: row.protocol,
      capabilities,
      expires_at: row.expires_at,
      signature: row.signature,
      last_seen: row.last_seen,
      last_success: row.last_success,
      success_count: row.success_count,
      fail_count: row.fail_count,
      score: row.score,
      updated_at: row.updated_at,
    };
  }

  _evict() {
    if (this.size() <= this.maxPeers) return;
    if (this.db) {
      try {
        this.db.run(
          `DELETE FROM p2p_peer_db WHERE peer_id IN (
             SELECT peer_id FROM p2p_peer_db ORDER BY score ASC, last_seen ASC LIMIT ?
           )`,
          Math.max(10, this.size() - this.maxPeers)
        );
      } catch { /* ignore */ }
      return;
    }
    const sorted = [...this._mem.entries()].sort((a, b) => (a[1].score || 0) - (b[1].score || 0));
    const drop = this._mem.size - this.maxPeers;
    for (let i = 0; i < drop; i++) this._mem.delete(sorted[i][0]);
  }
}

module.exports = { PeerDatabase, MAX_PEERS, DEFAULT_TTL_MS };
