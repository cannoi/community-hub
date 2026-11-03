'use strict';
/**
 * Phase 2 — libp2p Connection adapter.
 * Loaded only when cfg.p2p.enabled === true. Uses dynamic import() because
 * libp2p is ESM-only while the Hub is CommonJS.
 *
 * Scope (Phase 2 only):
 *  - stable PeerId (separate from Hub Ed25519 signing key)
 *  - WebSocket transport (reuse HTTP port surface via reverse-proxy later)
 *  - Noise + Yamux
 *  - identify + ping
 *  - connection limits, start/stop, basic dial/listen lifecycle
 * NOT in scope: DHT, GossipSub, NAT/relay, media, range sync.
 */
const fs = require('fs');
const path = require('path');
const { NetworkAdapter } = require('../adapter/interface');

const DEFAULT_MAX_CONNECTIONS = 50;
const DEFAULT_DIAL_TIMEOUT_MS = 15000;

class Libp2pAdapter extends NetworkAdapter {
  /**
   * @param {{ cfg: object, log: object, keyDir?: string }} opts
   */
  constructor(opts) {
    super();
    this.cfg = opts.cfg || {};
    this.log = opts.log || { debug() {}, info() {}, warn() {}, error() {} };
    this.keyDir = opts.keyDir || (this.cfg.keyDir) || path.join(this.cfg.dataDir || './data', 'keys');
    this._node = null;
    this._peerId = null;
    this._started = false;
    this._starting = null;
    this._loadError = null;
  }

  kind() { return 'p2p'; }
  isEnabled() { return true; }

  /** Human status — never includes private keys or multiaddrs that leak secrets. */
  status() {
    const peers = this._node ? this._node.getConnections().length : 0;
    return {
      kind: 'p2p',
      enabled: true,
      peers,
      state: this._started ? 'running' : (this._loadError ? 'error' : 'stopped'),
      peer_id: this._peerId ? String(this._peerId) : null,
      error: this._loadError ? String(this._loadError).slice(0, 120) : null,
    };
  }

  async start() {
    if (this._started) return;
    if (this._starting) return this._starting;
    this._starting = this._doStart().finally(() => { this._starting = null; });
    return this._starting;
  }

  async _doStart() {
    try {
      const mods = await this._loadModules();
      this._peerId = await this._loadOrCreatePeerId(mods);
      const p2pCfg = this.cfg.p2p || {};
      const maxConn = Number(p2pCfg.maxConnections) > 0 ? Number(p2pCfg.maxConnections) : DEFAULT_MAX_CONNECTIONS;
      const dialTimeout = Number(p2pCfg.dialTimeoutMs) > 0 ? Number(p2pCfg.dialTimeoutMs) : DEFAULT_DIAL_TIMEOUT_MS;
      const listen = Array.isArray(p2pCfg.listen) && p2pCfg.listen.length
        ? p2pCfg.listen
        : ['/ip4/0.0.0.0/tcp/0/ws']; // ephemeral port; SoloHost/reverse-proxy can map later. No extra fixed TCP port required of the Hub HTTP surface.
      const bootstrap = Array.isArray(p2pCfg.bootstrap) ? p2pCfg.bootstrap.filter(Boolean) : [];

      const node = await mods.createLibp2p({
        privateKey: this._peerId, // libp2p v3 uses privateKey for PeerId identity
        addresses: { listen },
        transports: [mods.webSockets()],
        connectionEncrypters: [mods.noise()],
        streamMuxers: [mods.yamux()],
        services: {
          identify: mods.identify(),
          ping: mods.ping(),
        },
        connectionManager: {
          maxConnections: maxConn,
          dialTimeout,
        },
      });

      node.addEventListener('peer:connect', (evt) => {
        try {
          const id = evt.detail?.toString?.() || String(evt.detail);
          this.log.debug('p2p peer:connect ' + id.slice(0, 24));
        } catch { /* ignore */ }
      });
      node.addEventListener('peer:disconnect', (evt) => {
        try {
          const id = evt.detail?.toString?.() || String(evt.detail);
          this.log.debug('p2p peer:disconnect ' + id.slice(0, 24));
        } catch { /* ignore */ }
      });

      await node.start();
      this._node = node;
      this._started = true;
      this._loadError = null;

      // Best-effort dial bootstrap peers (non-blocking failures)
      for (const addr of bootstrap) {
        this._dialSafe(addr).catch(() => {});
      }

      const addrs = node.getMultiaddrs().map((a) => a.toString());
      this.log.info('p2p started peer=' + String(node.peerId).slice(0, 20) + ' listen=' + (addrs[0] || 'none'));
    } catch (e) {
      this._loadError = e.message || String(e);
      this.log.warn('p2p start failed: ' + this._loadError);
      throw e;
    }
  }

  async stop() {
    this._started = false;
    const n = this._node;
    this._node = null;
    if (n) {
      try { await n.stop(); } catch (e) { this.log.debug('p2p stop: ' + e.message); }
    }
  }

  async listPeers() {
    if (!this._node) return [];
    try {
      const conns = this._node.getConnections();
      return conns.map((c) => ({
        id: String(c.remotePeer),
        endpoint: (c.remoteAddr && c.remoteAddr.toString()) || undefined,
        meta: { status: c.status || 'open' },
      }));
    } catch {
      return [];
    }
  }

  async connect(peer) {
    if (!this._node || !peer) return;
    const target = peer.multiaddr || peer.endpoint || peer.addr || peer;
    if (typeof target !== 'string' || !target.startsWith('/')) {
      const err = new Error('p2p connect expects a multiaddr string');
      err.code = 'E_P2P_BAD_ADDR';
      throw err;
    }
    await this._dialSafe(target);
  }

  async disconnect(peerId) {
    if (!this._node || !peerId) return;
    try {
      const conns = this._node.getConnections(peerId);
      for (const c of conns) {
        try { await c.close(); } catch { /* ignore */ }
      }
    } catch (e) {
      this.log.debug('p2p disconnect: ' + e.message);
    }
  }

  async publish(/* topic, data */) {
    // Phase 4 (GossipSub) — no-op in Phase 2
  }

  subscribe(/* topic, handler */) {
    return () => {};
  }

  async syncRange(/* peerId, query */) {
    return { events: [] };
  }

  // ---------- internals ----------

  async _dialSafe(multiaddr) {
    if (!this._node) return;
    try {
      await this._node.dial(multiaddr);
    } catch (e) {
      this.log.debug('p2p dial failed ' + String(multiaddr).slice(0, 40) + ': ' + e.message);
      throw e;
    }
  }

  async _loadModules() {
    // Dynamic import — works from CJS under Node >=22
    const [
      libp2pMod,
      wsMod,
      noiseMod,
      yamuxMod,
      identifyMod,
      pingMod,
      peerIdMod,
      cryptoMod,
    ] = await Promise.all([
      import('libp2p'),
      import('@libp2p/websockets'),
      import('@libp2p/noise'),
      import('@libp2p/yamux'),
      import('@libp2p/identify'),
      import('@libp2p/ping'),
      import('@libp2p/peer-id'),
      import('@libp2p/crypto'),
    ]);
    return {
      createLibp2p: libp2pMod.createLibp2p,
      webSockets: wsMod.webSockets,
      noise: noiseMod.noise,
      yamux: yamuxMod.yamux,
      identify: identifyMod.identify,
      ping: pingMod.ping,
      peerIdFromPrivateKey: peerIdMod.peerIdFromPrivateKey,
      privateKeyFromProtobuf: peerIdMod.privateKeyFromProtobuf,
      generateKeyPair: cryptoMod.generateKeyPair,
      privateKeyToProtobuf: cryptoMod.privateKeyToProtobuf || peerIdMod.privateKeyToProtobuf,
      exportPrivateKeyProtobuf: cryptoMod.marshalPrivateKey || cryptoMod.privateKeyToProtobuf,
    };
  }

  /**
   * Stable PeerId stored under keyDir/p2p-peer.pb — independent of Hub Ed25519 signing key.
   * Never logs or returns the raw private key material.
   */
  async _loadOrCreatePeerId(mods) {
    fs.mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
    const keyPath = path.join(this.keyDir, 'p2p-peer.pb');
    if (fs.existsSync(keyPath)) {
      const bytes = fs.readFileSync(keyPath);
      try {
        // libp2p v3: privateKeyFromProtobuf / peerIdFromPrivateKey
        if (typeof mods.privateKeyFromProtobuf === 'function') {
          const pk = mods.privateKeyFromProtobuf(bytes);
          if (typeof mods.peerIdFromPrivateKey === 'function') {
            return mods.peerIdFromPrivateKey(pk);
          }
          return pk; // some versions accept PrivateKey directly as identity
        }
      } catch (e) {
        this.log.warn('p2p: could not load existing peer key, regenerating: ' + e.message);
      }
    }
    // Generate new Ed25519 key for libp2p only
    const key = await mods.generateKeyPair('Ed25519');
    let marshalled;
    if (typeof mods.privateKeyToProtobuf === 'function') {
      marshalled = mods.privateKeyToProtobuf(key);
    } else if (typeof mods.exportPrivateKeyProtobuf === 'function') {
      marshalled = mods.exportPrivateKeyProtobuf(key);
    } else if (key.bytes) {
      marshalled = key.bytes;
    } else {
      throw new Error('cannot serialise libp2p private key');
    }
    fs.writeFileSync(keyPath, Buffer.from(marshalled), { mode: 0o600 });
    if (typeof mods.peerIdFromPrivateKey === 'function') {
      return mods.peerIdFromPrivateKey(key);
    }
    return key;
  }
}

module.exports = { Libp2pAdapter };
