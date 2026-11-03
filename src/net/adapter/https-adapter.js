'use strict';
const { NetworkAdapter } = require('./interface');

/**
 * HTTPS federation adapter — thin façade over the existing Peers + Transport.
 * Keeps all pre-P2P behaviour when this is the active adapter.
 */
class HttpsAdapter extends NetworkAdapter {
  constructor({ peers, transport, log }) {
    super();
    this.peers = peers;
    this.transport = transport;
    this.log = log || { debug() {}, info() {}, warn() {} };
    this._started = false;
  }
  kind() { return 'https'; }
  isEnabled() { return true; }
  async start() {
    this._started = true;
    // peers.start() is still owned by hub.js for backward compatibility
  }
  async stop() {
    this._started = false;
  }
  async listPeers() {
    try {
      const list = this.peers.list ? this.peers.list() : [];
      return (list || []).map((p) => ({
        id: p.account || p.id || p.endpoint,
        endpoint: p.endpoint,
        meta: { status: p.status, name: p.name },
      }));
    } catch {
      return [];
    }
  }
  async connect(peer) {
    if (!peer || !peer.endpoint) return;
    if (typeof this.peers.add === 'function') {
      await this.peers.add({ endpoint: peer.endpoint });
    }
  }
  async disconnect(peerId) {
    if (typeof this.peers.remove === 'function') {
      await this.peers.remove(peerId);
    }
  }
  async publish(_topic, _data) {
    // HTTPS federation pushes via existing inbox / connect paths; no topic publish yet.
  }
  subscribe(_topic, _handler) {
    return () => {};
  }
  status() {
    let peers = 0;
    try {
      const list = this.peers.list ? this.peers.list() : [];
      peers = (list || []).length;
    } catch { /* ignore */ }
    return { kind: 'https', enabled: true, peers, state: this._started ? 'running' : 'stopped' };
  }
}

module.exports = { HttpsAdapter };
