'use strict';
/**
 * Network Adapter interface (Phase 1 foundation).
 * Social / Ledger / Presence talk only to this surface; concrete transports
 * (HTTPS federation today, libp2p later) implement it.
 *
 * When P2P is disabled the NullAdapter is used and behaviour is identical
 * to pre-2.3.0 HTTPS-only federation.
 */

/** @typedef {{ id: string, endpoint?: string, multiaddrs?: string[], meta?: object }} PeerInfo */
/** @typedef {{ topic: string, data: Buffer|Uint8Array|string, from?: string }} Message */

class NetworkAdapter {
  /** @returns {Promise<void>} */
  async start() { throw new Error('not implemented'); }
  /** @returns {Promise<void>} */
  async stop() { throw new Error('not implemented'); }
  /** @returns {boolean} */
  isEnabled() { return false; }
  /** @returns {string} 'https' | 'p2p' | 'null' */
  kind() { return 'null'; }
  /** @returns {Promise<PeerInfo[]>} */
  async listPeers() { return []; }
  /** Connect to a peer by endpoint or multiaddr. */
  async connect(_peer) { /* no-op */ }
  async disconnect(_peerId) { /* no-op */ }
  /** Publish a signed event / notification to a topic (or HTTPS peers). */
  async publish(_topic, _data) { /* no-op */ }
  /** Subscribe; handler receives Message. Returns unsubscribe fn. */
  subscribe(_topic, _handler) { return () => {}; }
  /** Optional: request missing event range from a peer. */
  async syncRange(_peerId, _query) { return { events: [] }; }
  /** Human-readable status for UI / AI (no secrets). */
  status() {
    return { kind: this.kind(), enabled: this.isEnabled(), peers: 0, state: 'idle' };
  }
}

module.exports = { NetworkAdapter };
