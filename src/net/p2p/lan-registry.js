'use strict';
/**
 * Local peer registry for LAN / mDNS discoveries.
 * Independent of DHT and Internet bootstrap — peers discovered on the
 * local network are tracked here even when all external seeds are offline.
 *
 * Sources: 'mdns' | 'lan' | 'manual' | 'dht' | 'bootstrap' | 'relay'
 */
class LanRegistry {
  constructor({ maxPeers = 200, ttlMs = 10 * 60 * 1000 } = {}) {
    this._peers = new Map(); // peerId → record
    this.maxPeers = maxPeers;
    this.ttlMs = ttlMs;
  }

  /**
   * @param {string} id
   * @param {{ multiaddrs?: string[], source?: string, name?: string }} info
   */
  upsert(id, info = {}) {
    if (!id) return;
    const prev = this._peers.get(id) || {};
    const addrs = new Set(prev.multiaddrs || []);
    for (const a of info.multiaddrs || []) if (a) addrs.add(String(a));
    this._peers.set(id, {
      id,
      multiaddrs: [...addrs].slice(0, 16),
      source: info.source || prev.source || 'lan',
      name: info.name || prev.name || undefined,
      lastSeen: Date.now(),
      failures: prev.failures || 0,
    });
    this._evict();
  }

  get(id) {
    const r = this._peers.get(id);
    if (!r) return null;
    if (Date.now() - r.lastSeen > this.ttlMs) {
      this._peers.delete(id);
      return null;
    }
    return { ...r };
  }

  list({ source, aliveOnly = true } = {}) {
    const now = Date.now();
    const out = [];
    for (const [id, r] of this._peers) {
      if (aliveOnly && now - r.lastSeen > this.ttlMs) {
        this._peers.delete(id);
        continue;
      }
      if (source && r.source !== source) continue;
      out.push({ ...r });
    }
    return out;
  }

  /** Peers discovered purely on LAN (mdns/lan) — no Internet required. */
  listLan() {
    return this.list().filter((p) => p.source === 'mdns' || p.source === 'lan');
  }

  markFailure(id) {
    const r = this._peers.get(id);
    if (r) r.failures = (r.failures || 0) + 1;
  }

  markSuccess(id) {
    const r = this._peers.get(id);
    if (r) { r.failures = 0; r.lastSeen = Date.now(); }
  }

  size() { return this._peers.size; }

  clear() { this._peers.clear(); }

  _evict() {
    if (this._peers.size <= this.maxPeers) return;
    const sorted = [...this._peers.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    const drop = this._peers.size - this.maxPeers;
    for (let i = 0; i < drop; i++) this._peers.delete(sorted[i][0]);
  }
}

module.exports = { LanRegistry };
