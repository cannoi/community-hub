
'use strict';
/**
 * Zero-Config Network Engine — user-facing connection lifecycle.
 * Reuses existing adapter/bootstrap/presence; does not create a second P2P stack.
 *
 * UX states (simple): connecting | discovering | connected | syncing | degraded | reconnecting | offline
 */
const netLog = require('./network-log');

const UX = Object.freeze({
  CONNECTING: 'connecting',
  DISCOVERING: 'discovering',
  CONNECTED: 'connected',
  SYNCING: 'syncing',
  DEGRADED: 'degraded',
  RECONNECTING: 'reconnecting',
  OFFLINE: 'offline',
});

class ZeroConfigEngine {
  constructor({ hub, log }) {
    this.hub = hub;
    this.log = log || { info() {}, warn() {}, debug() {} };
    this._ux = UX.CONNECTING;
    this._startedAt = 0;
    this._lastError = null;
    this._timer = null;
  }

  start() {
    this._startedAt = Date.now();
    this._ux = UX.CONNECTING;
    try { netLog.push('info', 'zce', 'zero-config engine start'); } catch { /* ignore */ }
    this._tick();
    this._timer = setInterval(() => this._tick(), 8000);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _tick() {
    try {
      const hub = this.hub;
      const p2p = hub.net && typeof hub.net.status === 'function' ? hub.net.status() : null;
      const peers = hub.peers && typeof hub.peers.status === 'function' ? hub.peers.status() : null;
      const fedHealthy = peers ? Number(peers.healthy || 0) : 0;
      const p2pPeers = p2p ? Number(p2p.peers || 0) : 0;
      const p2pState = p2p && p2p.state;
      const netState = p2p && p2p.network_state;
      const bs = p2p && p2p.bootstrap;
      const known = bs && (bs.known || bs.known_peers || 0);
      const joined = bs && bs.state === 'NETWORK_JOINED';

      if (p2pState === 'unavailable' || p2pState === 'stopped') {
        // HTTPS federation may still work
        if (fedHealthy > 0) this._ux = UX.CONNECTED;
        else this._ux = UX.OFFLINE;
        return;
      }
      if (p2pState === 'starting' || p2pState === 'loading') {
        this._ux = UX.CONNECTING;
        return;
      }
      if (p2pPeers > 0 || fedHealthy > 0 || joined) {
        const syncing = peers && peers.content_sync === 'trusted' && (peers.last_sync_at || 0) === 0 && fedHealthy > 0;
        this._ux = syncing ? UX.SYNCING : (p2pPeers > 0 || fedHealthy > 0 ? UX.CONNECTED : UX.DISCOVERING);
        if (netState === 'GLOBAL_DEGRADED' || (known > 3 && p2pPeers === 0 && fedHealthy === 0)) {
          this._ux = UX.DEGRADED;
        }
        return;
      }
      if (known > 0 || (bs && bs.state === 'WAITING_FOR_FIRST_PEER')) {
        this._ux = UX.DISCOVERING;
        return;
      }
      if (netState === 'RECOVERING') {
        this._ux = UX.RECONNECTING;
        return;
      }
      this._ux = Date.now() - this._startedAt < 20000 ? UX.CONNECTING : UX.DISCOVERING;
    } catch (e) {
      this._lastError = e && e.message;
      this._ux = UX.DEGRADED;
    }
  }

  /** Simple status for UI — no IP/peer id in normal path */
  status() {
    this._tick();
    return {
      ux: this._ux,
      label_key: 'net.ux.' + this._ux,
      started_at: this._startedAt || null,
      // technical snapshot only for diagnostics
      detail: undefined,
    };
  }

  diagnostics() {
    const hub = this.hub;
    let p2p = null, peers = null;
    try { p2p = hub.net && hub.net.status && hub.net.status(); } catch { /* ignore */ }
    try { peers = hub.peers && hub.peers.status && hub.peers.status(); } catch { /* ignore */ }
    return {
      ux: this._ux,
      p2p_peers: p2p && p2p.peers,
      p2p_state: p2p && p2p.state,
      network_state: p2p && p2p.network_state,
      federation_healthy: peers && peers.healthy,
      problems: p2p && p2p.problems,
      last_error: this._lastError,
      self_heal: p2p && p2p.self_heal,
      trust: p2p && p2p.trust,
      reachability: p2p && p2p.reachability,
      preferred_transport: p2p && p2p.preferred_transport,
    };
  }
}

module.exports = { ZeroConfigEngine, UX };
