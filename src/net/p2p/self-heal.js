'use strict';
/**
 * Phase 2 — Self-Healing coordinator (zero-config).
 * Does not replace libp2p; schedules heal actions with backoff+jitter.
 *
 * Peer lifecycle (plain language for diagnostics):
 *   discovered → reachable → connected → authenticated → syncing → synced
 *   any state → degraded | offline
 */
const netLog = require('../network-log');

const PEER_LIFECYCLE = Object.freeze({
  DISCOVERED: 'discovered',
  REACHABLE: 'reachable',
  CONNECTED: 'connected',
  AUTHENTICATED: 'authenticated',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  DEGRADED: 'degraded',
  OFFLINE: 'offline',
});

function jitter(ms) {
  const base = Math.max(100, Number(ms) || 1000);
  return Math.floor(base * (0.7 + Math.random() * 0.6));
}

class SelfHealEngine {
  /**
   * @param {{
   *   log?: object,
   *   getPublicIp?: () => Promise<string|null>,
   *   onIpChanged?: (prev: string, next: string) => void|Promise<void>,
   *   requestReconnect?: () => void|Promise<void>,
   *   requestRelayPass?: () => void|Promise<void>,
   *   maxBackoffMs?: number,
   * }} opts
   */
  constructor(opts = {}) {
    this.log = opts.log || { debug() {}, info() {}, warn() {} };
    this.getPublicIp = opts.getPublicIp || null;
    this.onIpChanged = opts.onIpChanged || null;
    this.requestReconnect = opts.requestReconnect || null;
    this.requestRelayPass = opts.requestRelayPass || null;
    this.maxBackoffMs = opts.maxBackoffMs || 120000;
    this._lastPublicIp = null;
    this._backoffMs = 2000;
    this._failStreak = 0;
    this._timer = null;
    this._peerLife = new Map(); // peerId -> { state, at, fails }
    this._stats = { heals: 0, ip_changes: 0, relay_escalations: 0 };
  }

  start(intervalMs = 20000) {
    this.stop();
    this._timer = setInterval(() => { this.tick().catch(() => {}); }, intervalMs);
    if (this._timer.unref) this._timer.unref();
    this.tick().catch(() => {});
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  notePeer(peerId, state) {
    if (!peerId) return;
    const id = String(peerId).slice(0, 80);
    const prev = this._peerLife.get(id);
    this._peerLife.set(id, {
      state: PEER_LIFECYCLE[state] ? state : (state || PEER_LIFECYCLE.DISCOVERED),
      at: Date.now(),
      fails: state === PEER_LIFECYCLE.OFFLINE || state === PEER_LIFECYCLE.DEGRADED
        ? ((prev && prev.fails) || 0) + 1
        : 0,
    });
    if (this._peerLife.size > 200) {
      const first = this._peerLife.keys().next().value;
      this._peerLife.delete(first);
    }
  }

  noteDialResult(peerIdOrAddr, ok) {
    if (ok) {
      this._failStreak = 0;
      this._backoffMs = 2000;
      if (peerIdOrAddr) this.notePeer(peerIdOrAddr, PEER_LIFECYCLE.CONNECTED);
    } else {
      this._failStreak++;
      this._backoffMs = Math.min(this.maxBackoffMs, Math.floor(this._backoffMs * 1.5));
      if (peerIdOrAddr) this.notePeer(peerIdOrAddr, PEER_LIFECYCLE.DEGRADED);
    }
  }

  async tick() {
    // IP change detection
    if (typeof this.getPublicIp === 'function') {
      try {
        const ip = await this.getPublicIp();
        if (ip && this._lastPublicIp && ip !== this._lastPublicIp) {
          this._stats.ip_changes++;
          try { netLog.push('warn', 'ip_change', this._lastPublicIp + ' -> ' + ip); } catch { /* ignore */ }
          if (typeof this.onIpChanged === 'function') {
            await this.onIpChanged(this._lastPublicIp, ip);
          }
          this._failStreak = 0;
          this._backoffMs = 2000;
        }
        if (ip) this._lastPublicIp = ip;
      } catch { /* ignore */ }
    }

    // Escalate to relay if many consecutive dial failures
    if (this._failStreak >= 3 && typeof this.requestRelayPass === 'function') {
      this._stats.relay_escalations++;
      try { netLog.push('info', 'heal_relay', 'fail_streak=' + this._failStreak); } catch { /* ignore */ }
      try { await this.requestRelayPass(); } catch { /* ignore */ }
    }

    // Reconnect pass with backoff gate
    const due = !this._lastHealAt || (Date.now() - this._lastHealAt >= jitter(this._backoffMs));
    if (due && typeof this.requestReconnect === 'function') {
      this._lastHealAt = Date.now();
      this._stats.heals++;
      try { await this.requestReconnect(); } catch { /* ignore */ }
    }
  }

  status() {
    const peers = [];
    for (const [id, v] of this._peerLife) {
      peers.push({ peer_id: id.slice(0, 24), state: v.state, fails: v.fails, at: v.at });
    }
    return {
      phase: 2,
      self_heal: true,
      fail_streak: this._failStreak,
      backoff_ms: this._backoffMs,
      last_public_ip: this._lastPublicIp,
      stats: { ...this._stats },
      peers: peers.slice(0, 30),
    };
  }
}

module.exports = { SelfHealEngine, PEER_LIFECYCLE, jitter };
