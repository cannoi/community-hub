'use strict';
/**
 * Phase 4 — Regional / Language Peer Directory (sharded, paginated).
 * Does not store a global full-text index of all posts — only peer metadata for discovery.
 * Peer ID is identity; region/language are routing signals, not hard filters.
 */
const crypto = require('crypto');

const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const MAX_PAGE = 50;

function shardKey(region, language) {
  const r = String(region || 'ZZ').toUpperCase().slice(0, 2);
  const l = String(language || 'und').toLowerCase().slice(0, 8);
  return r + ':' + l;
}

function hashShard(peerId, shards = 16) {
  const h = crypto.createHash('sha256').update(String(peerId || '')).digest();
  return h[0] % Math.max(1, shards);
}

class RegionalDirectory {
  /**
   * @param {{ ttlMs?: number, maxEntries?: number, shards?: number, log?: object }} opts
   */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries || 5000;
    this.shards = opts.shards || 16;
    this.log = opts.log || { debug() {} };
    /** @type {Map<string, object>} peer_id -> record */
    this._byId = new Map();
    /** shard index -> Set of peer_id */
    this._shards = new Map();
    this._seq = 0;
  }

  _touchShard(peerId) {
    const s = hashShard(peerId, this.shards);
    if (!this._shards.has(s)) this._shards.set(s, new Set());
    this._shards.get(s).add(peerId);
    return s;
  }

  put(record) {
    if (!record || !record.peer_id) return { ok: false, reason: 'no_peer_id' };
    const id = String(record.peer_id).slice(0, 80);
    const now = Date.now();
    const prev = this._byId.get(id);
    const entry = {
      peer_id: id,
      multiaddrs: Array.isArray(record.multiaddrs) ? record.multiaddrs.slice(0, 8) : [],
      region: String(record.region || 'ZZ').toUpperCase().slice(0, 2),
      languages: Array.isArray(record.languages)
        ? record.languages.map((x) => String(x).toLowerCase().slice(0, 8)).slice(0, 8)
        : (record.language ? [String(record.language).toLowerCase().slice(0, 8)] : ['und']),
      topics: Array.isArray(record.topics)
        ? record.topics.map((x) => String(x).slice(0, 32)).slice(0, 16)
        : [],
      capabilities: Array.isArray(record.capabilities) ? record.capabilities.slice(0, 16) : [],
      network: record.network || 'cannoi',
      expires_at: Number(record.expires_at) || (now + this.ttlMs),
      updated_at: now,
      seq: ++this._seq,
      shard: hashShard(id, this.shards),
      verified: !!record.verified,
    };
    if (entry.expires_at < now) return { ok: false, reason: 'expired' };
    // Evict if full
    if (!prev && this._byId.size >= this.maxEntries) {
      this._evictOldest();
    }
    if (prev) {
      const oldShard = prev.shard;
      if (this._shards.has(oldShard)) this._shards.get(oldShard).delete(id);
    }
    this._byId.set(id, entry);
    this._touchShard(id);
    return { ok: true, seq: entry.seq, shard: entry.shard };
  }

  _evictOldest() {
    let oldest = null;
    for (const [id, e] of this._byId) {
      if (!oldest || e.updated_at < oldest.updated_at) oldest = { id, updated_at: e.updated_at };
    }
    if (oldest) this.remove(oldest.id);
  }

  remove(peerId) {
    const id = String(peerId);
    const e = this._byId.get(id);
    if (!e) return false;
    this._byId.delete(id);
    if (this._shards.has(e.shard)) this._shards.get(e.shard).delete(id);
    return true;
  }

  prune(now = Date.now()) {
    let n = 0;
    for (const [id, e] of [...this._byId.entries()]) {
      if (e.expires_at <= now) {
        this.remove(id);
        n++;
      }
    }
    return n;
  }

  /**
   * Paginated query. Region/language bias order only — does not hard-exclude others.
   * @param {{ region?: string, language?: string, shard?: number, cursor?: number, limit?: number, verified_only?: boolean }} q
   */
  query(q = {}) {
    this.prune();
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(q.limit) || 20));
    const cursor = Number(q.cursor) || 0;
    const preferRegion = q.region ? String(q.region).toUpperCase().slice(0, 2) : null;
    const preferLang = q.language ? String(q.language).toLowerCase().slice(0, 8) : null;
    const shardFilter = q.shard != null && q.shard !== '' ? Number(q.shard) : null;
    const verifiedOnly = !!q.verified_only;

    let list = [...this._byId.values()];
    if (shardFilter != null && !Number.isNaN(shardFilter)) {
      list = list.filter((e) => e.shard === shardFilter);
    }
    if (verifiedOnly) list = list.filter((e) => e.verified);

    // Sort: preferred region/lang first, then seq desc (incremental)
    list.sort((a, b) => {
      let sa = 0, sb = 0;
      if (preferRegion) {
        if (a.region === preferRegion) sa += 2;
        if (b.region === preferRegion) sb += 2;
      }
      if (preferLang) {
        if (a.languages.includes(preferLang)) sa += 1;
        if (b.languages.includes(preferLang)) sb += 1;
      }
      if (sb !== sa) return sb - sa;
      return b.seq - a.seq;
    });

    // Incremental: only entries with seq > cursor
    if (cursor > 0) list = list.filter((e) => e.seq > cursor);

    const page = list.slice(0, limit);
    const next_cursor = page.length ? page[page.length - 1].seq : cursor;
    return {
      items: page.map((e) => ({
        peer_id: e.peer_id,
        multiaddrs: e.multiaddrs,
        region: e.region,
        languages: e.languages,
        topics: e.topics,
        capabilities: e.capabilities,
        shard: e.shard,
        seq: e.seq,
        verified: e.verified,
        expires_at: e.expires_at,
      })),
      next_cursor,
      has_more: list.length > limit,
      total_approx: this._byId.size,
      shards: this.shards,
    };
  }

  stats() {
    const byRegion = {};
    for (const e of this._byId.values()) {
      byRegion[e.region] = (byRegion[e.region] || 0) + 1;
    }
    return {
      phase: 4,
      entries: this._byId.size,
      shards: this.shards,
      by_region: byRegion,
      seq: this._seq,
    };
  }
}

module.exports = { RegionalDirectory, shardKey, hashShard, MAX_PAGE };
