'use strict';
/**
 * Signed CANNOI Peer Record + lightweight registration (Phase 6).
 * Never publishes private keys, tokens, or private LAN addrs to public registries.
 */
const crypto = require('crypto');
const { NETWORK_ID, PROTOCOL_VERSION } = require('./types');

function createPeerRecord({
  peerId,
  multiaddrs = [],
  capabilities = [],
  reachability = 'unknown',
  protocol = PROTOCOL_VERSION,
  ttlMs = 24 * 60 * 60 * 1000,
  privateLanOk = false,
}) {
  const now = Date.now();
  const publicAddrs = (multiaddrs || []).filter((a) => {
    if (privateLanOk) return true;
    return !isPrivateMultiaddr(a);
  });
  return {
    peer_id: String(peerId),
    network: NETWORK_ID,
    protocol,
    multiaddrs: publicAddrs.slice(0, 8),
    capabilities: (capabilities || []).slice(0, 16),
    reachability: String(reachability).slice(0, 32),
    registered_at: now,
    expires_at: now + ttlMs,
    signature: null, // filled by signPeerRecord
  };
}

function signPeerRecord(record, signFn) {
  if (typeof signFn !== 'function') return record;
  const payload = canonicalPayload(record);
  try {
    const sig = signFn(payload);
    return { ...record, signature: typeof sig === 'string' ? sig : Buffer.from(sig).toString('base64') };
  } catch {
    return record;
  }
}

function verifyPeerRecord(record, verifyFn) {
  if (!record || !record.peer_id) return { ok: false, reason: 'malformed' };
  if (record.network && record.network !== NETWORK_ID) return { ok: false, reason: 'wrong-network' };
  if (record.expires_at && Number(record.expires_at) < Date.now()) return { ok: false, reason: 'expired' };
  if (typeof verifyFn === 'function' && record.signature) {
    try {
      const payload = canonicalPayload(record);
      if (!verifyFn(payload, record.signature, record.peer_id)) {
        return { ok: false, reason: 'bad-signature' };
      }
    } catch {
      return { ok: false, reason: 'verify-error' };
    }
  }
  return { ok: true };
}

function canonicalPayload(record) {
  return JSON.stringify({
    peer_id: record.peer_id,
    network: record.network || NETWORK_ID,
    protocol: record.protocol,
    multiaddrs: record.multiaddrs || [],
    capabilities: record.capabilities || [],
    reachability: record.reachability,
    registered_at: record.registered_at,
    expires_at: record.expires_at,
  });
}

function isPrivateMultiaddr(ma) {
  const s = String(ma || '');
  if (/\/ip4\/(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(s)) return true;
  if (/\/ip6\/(::1|fe80:)/.test(s)) return true;
  if (s.includes('.local')) return true;
  return false;
}

/**
 * In-memory + optional DB local registry of known CANNOI peer records.
 * Not a central authority — just a discovery cache.
 */
class PeerRegistry {
  constructor({ db = null, log = null } = {}) {
    this.db = db;
    this.log = log || { debug() {}, info() {}, warn() {} };
    this._mem = new Map();
  }

  put(record) {
    const v = verifyPeerRecord(record);
    if (!v.ok) return v;
    this._mem.set(record.peer_id, { ...record, cached_at: Date.now() });
    if (this.db) {
      try {
        this.db.run(
          `INSERT INTO p2p_peer_registry(peer_id, record, expires_at, updated_at)
           VALUES(?,?,?,?)
           ON CONFLICT(peer_id) DO UPDATE SET record=excluded.record, expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
          record.peer_id, JSON.stringify(record), record.expires_at || 0, Date.now()
        );
      } catch (e) {
        this.log.debug('registry put: ' + (e && e.message));
      }
    }
    return { ok: true };
  }

  get(peerId) {
    const m = this._mem.get(peerId);
    if (m && (!m.expires_at || m.expires_at > Date.now())) return m;
    if (this.db) {
      try {
        const row = this.db.get('SELECT record FROM p2p_peer_registry WHERE peer_id=? AND (expires_at=0 OR expires_at>?)', peerId, Date.now());
        if (row) return JSON.parse(row.record);
      } catch { /* ignore */ }
    }
    return null;
  }

  list(limit = 100) {
    const now = Date.now();
    const out = [];
    for (const r of this._mem.values()) {
      if (!r.expires_at || r.expires_at > now) out.push(r);
    }
    if (this.db && out.length < limit) {
      try {
        const rows = this.db.all(
          'SELECT record FROM p2p_peer_registry WHERE expires_at=0 OR expires_at>? ORDER BY updated_at DESC LIMIT ?',
          now, limit
        );
        for (const row of rows) {
          try {
            const r = JSON.parse(row.record);
            if (!out.find((x) => x.peer_id === r.peer_id)) out.push(r);
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    return out.slice(0, limit);
  }

  size() { return this.list(1000).length; }
}

module.exports = {
  createPeerRecord,
  signPeerRecord,
  verifyPeerRecord,
  PeerRegistry,
  isPrivateMultiaddr,
  canonicalPayload,
};
