'use strict';
/**
 * libp2p Connection + Discovery + NAT/Relay adapter
 * (Phase 1 repairs + Phase 2 DHT + Phase 3 AutoNAT / DCUtR / Circuit Relay v2).
 *
 * Phase 3 scope:
 *  - Circuit Relay v2 transport (dial/listen via relay)
 *  - Optional Circuit Relay server (opt-in only; never mandatory)
 *  - DCUtR hole punching
 *  - AutoNAT reachability detection
 *  - Relay bootstrap list + fallback tracking
 *
 * Honest limits: not every NAT topology supports direct connectivity.
 * Relay nodes are independently deployable; ordinary peers do not require them.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { NetworkAdapter } = require('../adapter/interface');
const { parseMultiaddr, checkDial, normalizeListen, denyPrivateHost } = require('./policy');
const { checkModules } = require('./availability');
const { LanRegistry } = require('./lan-registry');
const { createNullPlatformTransport } = require('./platform-transport');
const { LocalMessaging } = require('./local-messaging');
const { GossipFacade } = require('./gossip');
const { SyncEngine } = require('./sync-engine');
const { NetworkStateManager, STATES } = require('./network-state');
const { BootstrapManager } = require('./bootstrap/manager');

const DEFAULT_MAX_CONNECTIONS = 50;
const DEFAULT_DIAL_TIMEOUT_MS = 15000;

class Libp2pAdapter extends NetworkAdapter {
  /**
   * @param {{ cfg: object, log: object, keyDir?: string, httpPort?: function }} opts
   */
  constructor(opts) {
    super();
    this.cfg = opts.cfg || {};
    this.log = opts.log || { debug() {}, info() {}, warn() {}, error() {} };
    this.keyDir = opts.keyDir || (this.cfg.keyDir) || path.join(this.cfg.dataDir || './data', 'keys');
    this._node = null;
    this._peerId = null;
    this._starting = null;
    this._loadError = null;
    this._state = 'stopped';
    this._missing = [];
    this._note = null;
    this._privateKey = null;
    this._startedAt = null;
    this._lastDialError = null;
    this._discoveryEnabled = false;
    this._discoveryMissing = [];
    this._natRelayEnabled = false;
    this._natRelayMissing = [];
    this._relayServer = false;
    this._reachability = 'unknown'; // unknown | public | private
    this._relayConnections = 0;
    this._knownPeers = new Map();
    this._knownRelays = new Set(); // multiaddrs of relays
    this._lanRegistry = new LanRegistry();
    this._mdnsEnabled = false;
    this._lanMissing = [];
    this._platformTransports = {
      wifiDirect: createNullPlatformTransport('wifi-direct'),
      bluetooth: createNullPlatformTransport('bluetooth'),
    };
    this._localMessaging = new LocalMessaging({
      getNode: () => this._node,
      db: opts.db || null,
      log: this.log,
      localPeerId: () => (this._peerId ? String(this._peerId) : null),
    });
    this._gossip = new GossipFacade({
      getPubsub: () => (this._node && this._node.services && this._node.services.pubsub) || null,
      log: this.log,
      ratePerMin: (this.cfg.p2p && this.cfg.p2p.gossipRatePerMin) || 120,
      maxMessageSize: (this.cfg.p2p && this.cfg.p2p.gossipMaxMessageSize) || 65536,
      localPeerId: () => (this._peerId ? String(this._peerId) : null),
    });
    this._sync = new SyncEngine({
      db: opts.db || null,
      log: this.log,
      localPeerId: () => (this._peerId ? String(this._peerId) : null),
    });
    this._pubsubEnabled = false;
    this._pubsubMissing = [];
    this._netState = new NetworkStateManager({
      log: this.log,
      dwellMs: (this.cfg.p2p && this.cfg.p2p.stateDwellMs) || 8000,
      recoverMs: (this.cfg.p2p && this.cfg.p2p.stateRecoverMs) || 5000,
      onTransition: (from, to) => {
        // When recovering or gaining path, flush offline queue
        if (to !== STATES.OFFLINE && this._localMessaging) {
          this._localMessaging.flush().catch(() => {});
        }
      },
    });
    this._bootstrap = new BootstrapManager({
      cfg: this.cfg.p2p || {},
      db: opts.db || null,
      log: this.log,
      getPeerId: () => (this._peerId ? String(this._peerId) : null),
      getMultiaddrs: () => this._advertisedMultiaddrs(),
      getLanPeers: () => this._lanRegistry ? this._lanRegistry.listLan() : [],
      getReachability: () => this._reachability || 'unknown',
      getConnectedPeerIds: () => {
        try {
          if (!this._node) return [];
          return this._node.getConnections().map((c) => String(c.remotePeer));
        } catch { return []; }
      },
      dial: async (ma) => {
        if (this._state !== 'running' || !this._node) {
          const e = new Error('not running'); e.code = 'E_P2P_NOT_RUNNING'; throw e;
        }
        return this._dialSafe(ma);
      },
    });
    this._healthTimer = null;
    this._reconnectTimer = null;
    this._httpPort = typeof opts.httpPort === 'function' ? opts.httpPort : () => Number((this.cfg && this.cfg.port) || 0);
  }

  /** Build a public dial address through the existing HTTP/WebSocket gateway. */
  _advertisedMultiaddrs() {
    if (!this._node || !this._peerId) return [];
    const p2pCfg = this.cfg.p2p || {};
    if (!p2pCfg.wsGateway) return [];
    const raw = String(this.cfg.publicUrl || process.env.HUB_PUBLIC_URL || process.env.PUBLIC_URL || '').trim();
    if (!raw) return [];
    try {
      const u = new URL(raw);
      // A path-prefixed reverse proxy needs a path-aware gateway; do not publish a broken address.
      if (u.pathname && u.pathname !== '/') return [];
      const secure = u.protocol === 'https:';
      if (!secure && u.protocol !== 'http:') return [];
      const port = Number(u.port || (secure ? 443 : 80));
      if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
      const host = net.isIP(u.hostname) === 4 ? 'ip4' : net.isIP(u.hostname) === 6 ? 'ip6' : 'dns4';
      const transport = secure ? '/tls/ws' : '/ws';
      return [`/${host}/${u.hostname}/tcp/${port}${transport}/p2p/${String(this._peerId)}`];
    } catch { return []; }
  }

  bootstrapInfo() {
    const peerId = this._peerId ? String(this._peerId) : null;
    const multiaddrs = this._advertisedMultiaddrs();
    return {
      network: 'cannoi', protocol: '1', status: this._state === 'running' ? (multiaddrs.length ? 'advertised' : 'not-publicly-reachable') : this._state,
      peer_id: peerId, multiaddrs,
      peers: this._bootstrap ? this._bootstrap.listRegistry(50) : [],
      updated_at: new Date().toISOString(),
    };
  }

  kind() { return 'p2p'; }
  isEnabled() { return true; }

  status() {
    try {
    let peers = 0;
    let listeners = 0;
    let relayConns = 0;
    try {
      if (this._node) {
        const conns = this._node.getConnections();
        peers = conns.length;
        listeners = this._node.getMultiaddrs().length;
        for (const c of conns) {
          try {
            const ma = c.remoteAddr && String(c.remoteAddr);
            if (ma && ma.includes('/p2p-circuit')) relayConns++;
          } catch { /* ignore */ }
        }
      }
    } catch { /* stopping */ }
    this._relayConnections = relayConns;
    let bootstrap = undefined;
    try { bootstrap = this._bootstrap ? this._bootstrap.status() : undefined; } catch { bootstrap = undefined; }
    return {
      kind: 'p2p',
      enabled: true,
      peers,
      listeners,
      known_peers: this._knownPeers.size,
      relay_connections: relayConns,
      known_relays: this._knownRelays.size,
      lan_peers: this._lanRegistry.listLan().length,
      mdns: this._mdnsEnabled,
      pending_local_messages: this._localMessaging ? this._localMessaging.pendingCount() : 0,
      outbox: this._localMessaging && this._localMessaging.stats ? this._localMessaging.stats() : undefined,
      pubsub: this._pubsubEnabled,
      sync: this._sync ? this._sync.stats() : undefined,
      network_state: this._netState ? this._netState.state() : 'OFFLINE',
      preferred_transport: this._netState ? this._netState.preferredTransport() : 'store_and_forward',
      bootstrap: bootstrap,
      state: this._state,
      peer_id: this._peerId ? String(this._peerId) : null,
      discovery: this._discoveryEnabled,
      discovery_missing: this._discoveryEnabled ? undefined : (this._discoveryMissing.length ? this._discoveryMissing.slice(0, 6) : undefined),
      nat_relay: this._natRelayEnabled,
      nat_relay_missing: this._natRelayEnabled ? undefined : (this._natRelayMissing.length ? this._natRelayMissing.slice(0, 6) : undefined),
      relay_server: this._relayServer,
      reachability: this._reachability,
      error: this._loadError ? String(this._loadError).slice(0, 120) : null,
      last_dial_error: this._lastDialError ? String(this._lastDialError).slice(0, 120) : undefined,
      missing: this._state === 'unavailable' ? this._missing.slice(0, 12) : undefined,
      note: this._note || undefined,
      started_at: this._startedAt || undefined,
    };
    } catch (e) {
      return {
        kind: 'p2p', enabled: true, peers: 0, listeners: 0, state: this._state || 'error',
        error: String(e && e.message || e).slice(0, 120),
      };
    }
  }

  wsBackend() {
    if (!this._node || this._state !== 'running') return null;
    try {
      for (const a of this._node.getMultiaddrs()) {
        const m = /^\/ip4\/127\.0\.0\.1\/tcp\/(\d+)\/ws(?:\/|$)/.exec(String(a));
        if (m) return { host: '127.0.0.1', port: Number(m[1]) };
      }
    } catch { /* not ready */ }
    return null;
  }

  async start() {
    if (this._state === 'running') return;
    if (this._starting) return this._starting;
    this._starting = this._doStart().finally(() => { this._starting = null; });
    return this._starting;
  }

  async _doStart() {
    const avail = await checkModules();
    if (!avail.ok) {
      this._state = 'unavailable';
      this._missing = avail.missing;
      this._loadError = null;
      this._discoveryEnabled = false;
      this._discoveryMissing = avail.discoveryMissing || [];
      this._natRelayEnabled = false;
      this._natRelayMissing = avail.natRelayMissing || [];
      this._mdnsEnabled = false;
      this._lanMissing = avail.lanMissing || [];
      this._note = 'libp2p packages not installed';
      this.log.warn('p2p unavailable: libp2p packages are not installed (' + avail.missing.join(', ') + '). HTTPS federation is unaffected.');
      try { this._bootstrap.start(); } catch { /* ignore */ }
      return;
    }
    this._discoveryMissing = avail.discoveryMissing || [];
    this._natRelayMissing = avail.natRelayMissing || [];
    this._lanMissing = avail.lanMissing || [];
    this._state = 'starting';
    this._loadError = null;
    this._note = null;
    try {
      this._pubsubMissing = avail.pubsubMissing || [];
      const mods = await this._loadModules({
        discovery: avail.discovery,
        natRelay: avail.natRelay || (avail.natRelayMissing && avail.natRelayMissing.length < 3),
        lan: avail.lan || (avail.lanMissing && avail.lanMissing.length === 0),
        pubsub: avail.pubsub || false,
      });
      const id = await this._loadOrCreateKey(mods);
      this._privateKey = id.privateKey;
      this._peerId = id.peerId;
      const p2pCfg = this.cfg.p2p || {};
      const maxConn = Number(p2pCfg.maxConnections) > 0 ? Number(p2pCfg.maxConnections) : DEFAULT_MAX_CONNECTIONS;
      const dialTimeout = Number(p2pCfg.dialTimeoutMs) > 0 ? Number(p2pCfg.dialTimeoutMs) : DEFAULT_DIAL_TIMEOUT_MS;

      const lp = normalizeListen(p2pCfg.listen, {
        httpPort: Number(this._httpPort()) || 0,
        allowPublic: !!p2pCfg.allowPublicListen,
      });
      for (const r of lp.rejected) this.log.warn('p2p listen address rejected (' + r.code + '): ' + r.addr);

      // Circuit relay listen address (enables receiving relayed connections)
      const listenAddrs = [...lp.listen];
      if (mods.circuitRelayTransport && p2pCfg.relay !== false) {
        if (!listenAddrs.includes('/p2p-circuit')) listenAddrs.push('/p2p-circuit');
      }

      const allowPrivate = !!this.cfg.allowPrivatePeers || !!p2pCfg.lanOnly || p2pCfg.mdns !== false;
      const bootstrapAddrs = [];
      for (const raw of Array.isArray(p2pCfg.bootstrap) ? p2pCfg.bootstrap : []) {
        try {
          checkDial(parseMultiaddr(raw), { allowPrivate });
          bootstrapAddrs.push(raw);
        } catch (e) {
          this.log.warn('p2p bootstrap entry ignored (' + (e.code || 'invalid') + ')');
        }
      }
      // Known relay multiaddrs
      for (const raw of Array.isArray(p2pCfg.relayBootstrap) ? p2pCfg.relayBootstrap : []) {
        try {
          checkDial(parseMultiaddr(raw), { allowPrivate });
          this._knownRelays.add(raw);
          if (!bootstrapAddrs.includes(raw)) bootstrapAddrs.push(raw);
        } catch (e) {
          this.log.warn('p2p relay bootstrap ignored (' + (e.code || 'invalid') + ')');
        }
      }

      // --- transports ---
      const transports = [mods.webSockets()];
      if (mods.circuitRelayTransport && p2pCfg.relay !== false) {
        try {
          transports.push(mods.circuitRelayTransport());
          this._natRelayEnabled = true;
        } catch (e) {
          this.log.warn('p2p circuit relay transport init failed: ' + (e && e.message));
        }
      }

      // --- services ---
      const services = {
        identify: mods.identify(),
        ping: mods.ping(),
      };

      // DHT
      if (mods.kadDHT && p2pCfg.dht !== false) {
        try {
          services.dht = mods.kadDHT({
            clientMode: !!p2pCfg.dhtClientMode,
            protocol: p2pCfg.dhtProtocol || '/cannoi/kad/1.0.0',
          });
          this._discoveryEnabled = true;
        } catch (e) {
          this.log.warn('p2p DHT init failed: ' + (e && e.message));
          this._discoveryEnabled = false;
        }
      } else {
        this._discoveryEnabled = false;
        if (p2pCfg.dht !== false && this._discoveryMissing.length) {
          this.log.info('p2p discovery packages missing; DHT disabled');
        }
      }

      // AutoNAT
      if (mods.autoNAT && p2pCfg.autonat !== false) {
        try {
          services.autoNAT = mods.autoNAT();
        } catch (e) {
          this.log.warn('p2p AutoNAT init failed: ' + (e && e.message));
        }
      }

      // DCUtR (hole punching)
      if (mods.dcutr && p2pCfg.dcutr !== false) {
        try {
          services.dcutr = mods.dcutr();
        } catch (e) {
          this.log.warn('p2p DCUtR init failed: ' + (e && e.message));
        }
      }

      // Circuit Relay server (opt-in only)
      if (mods.circuitRelayServer && p2pCfg.relayServer === true) {
        try {
          const maxRes = Number(p2pCfg.relayMaxReservations) > 0 ? Number(p2pCfg.relayMaxReservations) : 15;
          services.circuitRelay = mods.circuitRelayServer({
            reservations: { maxReservations: maxRes },
          });
          this._relayServer = true;
          this.log.info('p2p Circuit Relay server enabled (maxReservations=' + maxRes + ')');
        } catch (e) {
          this.log.warn('p2p relay server init failed: ' + (e && e.message));
          this._relayServer = false;
        }
      }

      // GossipSub
      if (mods.gossipsub && p2pCfg.gossipsub !== false) {
        try {
          services.pubsub = mods.gossipsub({
            allowPublishToZeroTopicPeers: true,
            emitSelf: false,
          });
          this._pubsubEnabled = true;
        } catch (e) {
          this.log.warn('p2p GossipSub init failed: ' + (e && e.message));
          this._pubsubEnabled = false;
        }
      } else {
        this._pubsubEnabled = false;
        if (p2pCfg.gossipsub !== false && this._pubsubMissing.length) {
          this.log.info('p2p GossipSub package missing; pubsub disabled');
        }
      }

      // Peer discovery
      const peerDiscovery = [];
      if (mods.bootstrap && bootstrapAddrs.length > 0) {
        try {
          peerDiscovery.push(mods.bootstrap({ list: bootstrapAddrs }));
        } catch (e) {
          this.log.warn('p2p bootstrap discovery init failed: ' + (e && e.message));
        }
      }

      // mDNS — LAN discovery, independent of Internet / DHT / bootstrap
      if (mods.mdns && p2pCfg.mdns !== false) {
        try {
          const mdnsOpts = {
            interval: Number(p2pCfg.mdnsIntervalMs) > 0 ? Number(p2pCfg.mdnsIntervalMs) : 20000,
          };
          if (p2pCfg.mdnsServiceTag) mdnsOpts.serviceTag = p2pCfg.mdnsServiceTag;
          peerDiscovery.push(mods.mdns(mdnsOpts));
          this._mdnsEnabled = true;
          this.log.info('p2p mDNS LAN discovery enabled');
        } catch (e) {
          this.log.warn('p2p mDNS init failed: ' + (e && e.message));
          this._mdnsEnabled = false;
        }
      } else {
        this._mdnsEnabled = false;
        if (p2pCfg.mdns !== false && this._lanMissing.length) {
          this.log.info('p2p mDNS package missing; LAN discovery disabled');
        }
      }

      const nodeOpts = {
        privateKey: this._privateKey,
        addresses: { listen: listenAddrs },
        transports,
        connectionEncrypters: [mods.noise()],
        streamMuxers: [mods.yamux()],
        connectionGater: {
          denyDialMultiaddr: async (ma) => {
            try {
              const s = String(ma);
              // Always allow circuit relay multiaddrs
              if (s.includes('/p2p-circuit')) return false;
              return denyPrivateHost(s, allowPrivate);
            } catch { return true; }
          },
        },
        services,
        connectionManager: {
          maxConnections: maxConn,
          dialTimeout,
        },
      };
      if (peerDiscovery.length) nodeOpts.peerDiscovery = peerDiscovery;

      const node = await mods.createLibp2p(nodeOpts);

      node.addEventListener('peer:connect', (evt) => {
        try {
          const id = String(evt.detail);
          this._rememberPeer(id, null);
          this.log.debug('p2p peer:connect ' + id.slice(0, 24));
        } catch { /* ignore */ }
      });
      node.addEventListener('peer:disconnect', (evt) => {
        try {
          this.log.debug('p2p peer:disconnect ' + String(evt.detail).slice(0, 24));
        } catch { /* ignore */ }
      });
      node.addEventListener('peer:discovery', (evt) => {
        try {
          const peerInfo = evt.detail;
          if (!peerInfo || !peerInfo.id) return;
          const id = String(peerInfo.id);
          const addrs = (peerInfo.multiaddrs || []).map(String);
          // Classify source: private/link-local addresses → LAN/mDNS
          const isLan = addrs.some((a) =>
            /\/ip4\/(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) ||
            /\/ip6\/(::1|fe80:)/.test(a) ||
            a.includes('.local')
          );
          const source = isLan ? (this._mdnsEnabled ? 'mdns' : 'lan') : 'dht';
          this._rememberPeer(id, addrs);
          this._lanRegistry.upsert(id, { multiaddrs: addrs, source });
          this.log.debug('p2p peer:discovery ' + id.slice(0, 24) + ' source=' + source + ' addrs=' + addrs.length);
          if (addrs.length && this._state === 'running') {
            const ma = addrs.find((a) => a.includes('/ws') || a.includes('/wss') || a.includes('/tcp'));
            if (ma) this._dialSafe(ma + (ma.includes('/p2p/') ? '' : '/p2p/' + id)).catch(() => {});
          }
        } catch { /* ignore */ }
      });
      // AutoNAT reachability updates (if the service emits them)
      node.addEventListener('self:peer:update', () => {
        try {
          this._updateReachability();
        } catch { /* ignore */ }
      });

      await node.start();
      this._node = node;
      this._state = 'running';
      this._startedAt = new Date().toISOString();
      this._loadError = null;
      this._updateReachability();

      for (const addr of bootstrapAddrs) {
        this._dialSafe(addr).catch(() => {});
      }
      // Dial known relays to obtain reservations
      for (const ra of this._knownRelays) {
        this._dialSafe(ra).catch(() => {});
      }

      this._startBackgroundLoops(p2pCfg);
      try { await this._localMessaging.start(); } catch (e) { this.log.debug('local-msg start: ' + (e && e.message)); }
      try { await this._gossip.start(); } catch (e) { this.log.debug('gossip start: ' + (e && e.message)); }
      try { this._bootstrap.start(); } catch (e) { this.log.debug('bootstrap start: ' + (e && e.message)); }
      this._evaluateNetworkState();

      this.log.info(
        'p2p started peer=' + String(node.peerId).slice(0, 20) +
        ' listeners=' + node.getMultiaddrs().length +
        ' discovery=' + (this._discoveryEnabled ? 'dht' : 'off') +
        ' nat_relay=' + (this._natRelayEnabled ? 'on' : 'off') +
        ' relay_server=' + (this._relayServer ? 'on' : 'off') +
        ' mdns=' + (this._mdnsEnabled ? 'on' : 'off') +
        ' pubsub=' + (this._pubsubEnabled ? 'on' : 'off')
      );
    } catch (e) {
      this._state = 'error';
      this._loadError = e.message || String(e);
      this._node = null;
      this.log.warn('p2p start failed: ' + this._loadError);
    }
  }

  async stop() {
    this._stopBackgroundLoops();
    try { await this._localMessaging.stop(); } catch { /* ignore */ }
    try { this._gossip.stop(); } catch { /* ignore */ }
    try { this._bootstrap.stop(); } catch { /* ignore */ }
    if (this._starting) {
      try { await this._starting; } catch { /* ignore */ }
    }
    const prev = this._state;
    this._state = 'stopped';
    this._startedAt = null;
    this._reachability = 'unknown';
    try {
      this._netState.evaluate({
        peers: 0, directPeers: 0, relayPeers: 0, lanPeers: 0, knownRelays: 0,
        reachability: 'unknown', nodeRunning: false, pendingMessages: 0,
        mdnsEnabled: false, discoveryEnabled: false,
      });
    } catch { /* ignore */ }
    const n = this._node;
    this._node = null;
    if (n) {
      try { await n.stop(); } catch (e) { this.log.debug('p2p stop: ' + (e && e.message)); }
    }
    if (prev === 'running' || prev === 'starting') {
      this.log.info('p2p stopped');
    }
  }

  async listPeers() {
    if (!this._node || this._state !== 'running') return [];
    try {
      const conns = this._node.getConnections();
      return conns.map((c) => {
        const endpoint = (c.remoteAddr && c.remoteAddr.toString()) || undefined;
        const viaRelay = !!(endpoint && endpoint.includes('/p2p-circuit'));
        return {
          id: String(c.remotePeer),
          endpoint,
          meta: { status: c.status || 'open', via_relay: viaRelay },
        };
      });
    } catch {
      return [];
    }
  }

  listKnownPeers() {
    const out = [];
    for (const [id, info] of this._knownPeers) {
      out.push({
        id,
        multiaddrs: (info.multiaddrs || []).slice(0, 8),
        lastSeen: info.lastSeen,
        failures: info.failures || 0,
      });
    }
    return out;
  }

  listKnownRelays() {
    return [...this._knownRelays];
  }

  /** Peers discovered on the local network (mDNS / LAN). Works without Internet. */
  listLanPeers() {
    return this._lanRegistry.listLan();
  }

  /**
   * Platform transport handles (Wi-Fi Direct / Bluetooth).
   * Always available as null implementations until native clients plug in.
   * isAvailable() returns false on Node.js backend.
   */
  platformTransports() {
    return {
      wifiDirect: this._platformTransports.wifiDirect,
      bluetooth: this._platformTransports.bluetooth,
    };
  }

  /** Send a local/LAN message. Queues if peer unreachable. */
  async sendLocalMessage(toPeerId, type, payload) {
    return this._localMessaging.send(toPeerId, type, payload);
  }

  onLocalMessage(handler) {
    return this._localMessaging.onMessage(handler);
  }

  pendingLocalMessages() {
    return this._localMessaging.pendingCount();
  }

  async flushLocalMessages() {
    return this._localMessaging.flush();
  }

  outboxStats() {
    return this._localMessaging.stats();
  }

  listPendingMessages(limit = 50) {
    return this._localMessaging.listPending(limit);
  }

  async connect(peer) {
    const target = peer && typeof peer === 'object'
      ? (peer.multiaddr || peer.endpoint || peer.addr)
      : peer;
    // Circuit addresses contain /p2p-circuit — allow them through policy
    const isCircuit = String(target || '').includes('/p2p-circuit');
    if (!isCircuit) {
      checkDial(parseMultiaddr(target), { allowPrivate: !!this.cfg.allowPrivatePeers });
    } else {
      // Still parse for basic structure
      try { parseMultiaddr(String(target).split('/p2p-circuit')[0] + '/p2p/12D3KooWplaceholder000000000000000001'); } catch { /* best effort */ }
    }
    if (this._state !== 'running' || !this._node) {
      const err = new Error('p2p node is not running');
      err.code = 'E_P2P_NOT_RUNNING';
      throw err;
    }
    return this._dialSafe(target);
  }

  /**
   * Connect via a known relay when direct dial fails.
   * multiaddr form: /.../p2p/<relayPeerId>/p2p-circuit/p2p/<targetPeerId>
   */
  async connectViaRelay(targetPeerId, relayMultiaddr) {
    if (!targetPeerId || !relayMultiaddr) {
      const err = new Error('targetPeerId and relayMultiaddr required');
      err.code = 'E_P2P_BAD_ADDR';
      throw err;
    }
    const base = String(relayMultiaddr).replace(/\/$/, '');
    const circuit = base.includes('/p2p-circuit')
      ? base + '/p2p/' + targetPeerId
      : base + '/p2p-circuit/p2p/' + targetPeerId;
    return this.connect(circuit);
  }

  async disconnect(peerId) {
    if (!this._node || !peerId || this._state !== 'running') return;
    try {
      const conns = this._node.getConnections(peerId);
      for (const c of conns) {
        try { await c.close(); } catch { /* ignore */ }
      }
    } catch (e) {
      this.log.debug('p2p disconnect: ' + (e && e.message));
    }
  }

  async findPeer(peerIdStr, timeoutMs = 15000) {
    if (!this._node || this._state !== 'running') return null;
    if (!this._discoveryEnabled || !this._node.services || !this._node.services.dht) return null;
    try {
      const mods = await this._loadModules({ discovery: true });
      if (typeof mods.peerIdFromString !== 'function') return null;
      const peerId = await mods.peerIdFromString(peerIdStr);
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        if (this._node.peerRouting && typeof this._node.peerRouting.findPeer === 'function') {
          const info = await this._node.peerRouting.findPeer(peerId, { signal: ac.signal });
          if (info) {
            const addrs = (info.multiaddrs || []).map(String);
            this._rememberPeer(String(info.id || peerId), addrs);
            return { id: String(info.id || peerId), multiaddrs: addrs };
          }
        }
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      this.log.debug('p2p findPeer: ' + (e && e.message));
    }
    return null;
  }

  async publish(topic, data, opts) {
    return this._gossip.publish(topic, data, opts || {});
  }

  subscribe(topic, handler) {
    return this._gossip.subscribe(topic, handler);
  }

  async syncRange(peerId, query = {}) {
    const topic = (query && query.topic) || 'cannoi/events';
    const after = (query && query.after_seq) || 0;
    // Return local events the remote may be missing
    const events = this._sync.listSince(topic, after, (query && query.limit) || 200);
    return { events, topic, after_seq: after };
  }

  /** Append a signed/local sync event (policy: public|private|local). */
  appendSyncEvent(topic, body, opts) {
    return this._sync.append(topic, body, opts || {});
  }

  /** Ingest remote sync event with conflict resolution. */
  ingestSyncEvent(event) {
    return this._sync.ingest(event);
  }

  applySyncBatch(peerId, topic, events) {
    return this._sync.applySyncBatch(peerId, topic, events);
  }

  buildSyncRequest(peerId, topic) {
    return this._sync.buildSyncRequest(peerId, topic);
  }

  syncStats() {
    return this._sync.stats();
  }

  // ---------- internals ----------

  networkState() {
    return this._netState.snapshot();
  }

  preferredTransport() {
    return this._netState.preferredTransport();
  }

  registerBootstrapPeer(record) {
    if (!this._bootstrap || !record) return { accepted: 0 };
    return this._bootstrap.acceptExchange([record]);
  }

  bootstrapStatus() {
    return this._bootstrap.status();
  }

  bootstrapState() {
    return this._bootstrap.state();
  }

  _evaluateNetworkState() {
    let direct = 0, relay = 0, peers = 0;
    try {
      if (this._node) {
        const conns = this._node.getConnections();
        peers = conns.length;
        for (const c of conns) {
          try {
            const ma = c.remoteAddr && String(c.remoteAddr);
            if (ma && ma.includes('/p2p-circuit')) relay++;
            else direct++;
          } catch { direct++; }
        }
      }
    } catch { /* ignore */ }
    const signals = {
      peers,
      directPeers: direct,
      relayPeers: relay,
      lanPeers: this._lanRegistry ? this._lanRegistry.listLan().length : 0,
      knownRelays: this._knownRelays ? this._knownRelays.size : 0,
      reachability: this._reachability || 'unknown',
      nodeRunning: this._state === 'running' && !!this._node,
      pendingMessages: this._localMessaging ? this._localMessaging.pendingCount() : 0,
      mdnsEnabled: !!this._mdnsEnabled,
      discoveryEnabled: !!this._discoveryEnabled,
    };
    return this._netState.evaluate(signals);
  }

  _updateReachability() {
    if (!this._node) { this._reachability = 'unknown'; return; }
    try {
      const addrs = this._node.getMultiaddrs().map(String);
      const hasPublic = addrs.some((a) => {
        const m = /\/ip4\/([^/]+)/.exec(a);
        if (!m) return false;
        const ip = m[1];
        if (ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) return false;
        if (ip === '0.0.0.0') return false;
        return true;
      });
      const hasCircuit = addrs.some((a) => a.includes('/p2p-circuit'));
      if (hasPublic) this._reachability = 'public';
      else if (hasCircuit) this._reachability = 'private';
      else this._reachability = 'private';
    } catch {
      this._reachability = 'unknown';
    }
  }

  _rememberPeer(id, multiaddrs) {
    if (!id) return;
    const prev = this._knownPeers.get(id) || { multiaddrs: [], lastSeen: 0, failures: 0 };
    const merged = new Set(prev.multiaddrs || []);
    for (const a of multiaddrs || []) if (a) merged.add(String(a));
    this._knownPeers.set(id, {
      multiaddrs: [...merged].slice(0, 16),
      lastSeen: Date.now(),
      failures: prev.failures || 0,
    });
    if (this._knownPeers.size > 500) {
      const oldest = [...this._knownPeers.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      for (let i = 0; i < 50; i++) this._knownPeers.delete(oldest[i][0]);
    }
  }

  _startBackgroundLoops(p2pCfg) {
    this._stopBackgroundLoops();
    const healthMs = Number(p2pCfg.healthIntervalMs) > 0 ? Number(p2pCfg.healthIntervalMs) : 30000;
    const reconnectMs = Number(p2pCfg.reconnectIntervalMs) > 0 ? Number(p2pCfg.reconnectIntervalMs) : 15000;

    this._healthTimer = setInterval(() => { this._runHealthCheck().catch(() => {}); }, healthMs);
    if (this._healthTimer.unref) this._healthTimer.unref();

    this._reconnectTimer = setInterval(() => { this._runReconnect().catch(() => {}); }, reconnectMs);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  _stopBackgroundLoops() {
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
    if (this._reconnectTimer) { clearInterval(this._reconnectTimer); this._reconnectTimer = null; }
  }

  async _runHealthCheck() {
    if (!this._node || this._state !== 'running') {
      this._netState.evaluate({
        peers: 0, directPeers: 0, relayPeers: 0, lanPeers: 0, knownRelays: 0,
        reachability: 'unknown', nodeRunning: false,
        pendingMessages: this._localMessaging ? this._localMessaging.pendingCount() : 0,
        mdnsEnabled: this._mdnsEnabled, discoveryEnabled: this._discoveryEnabled,
      });
      return;
    }
    try {
      this._updateReachability();
      this._evaluateNetworkState();
      if (this._localMessaging && this._localMessaging.pendingCount() > 0) {
        await this._localMessaging.flush().catch(() => {});
      }
      const conns = this._node.getConnections();
      for (const c of conns) {
        const id = String(c.remotePeer);
        try {
          if (this._node.services && this._node.services.ping) {
            await this._node.services.ping.ping(c.remotePeer);
          }
          this._rememberPeer(id, c.remoteAddr ? [String(c.remoteAddr)] : null);
          const info = this._knownPeers.get(id);
          if (info) info.failures = 0;
        } catch {
          const info = this._knownPeers.get(id);
          if (info) info.failures = (info.failures || 0) + 1;
        }
      }
    } catch { /* ignore */ }
  }

  async _runReconnect() {
    if (!this._node || this._state !== 'running') return;
    const connected = new Set();
    try {
      for (const c of this._node.getConnections()) connected.add(String(c.remotePeer));
    } catch { return; }

    const preferred = this._netState.preferredTransport();
    const allowPrivate = !!this.cfg.allowPrivatePeers || !!(this.cfg.p2p && this.cfg.p2p.lanOnly) || (this.cfg.p2p && this.cfg.p2p.mdns !== false);

    // Order: prefer LAN/direct addresses first; relays later unless RELAY_ONLY
    const tryLanDirectFirst = preferred === 'lan' || preferred === 'direct' || preferred === 'direct_or_relay' || preferred === 'any';
    const tryRelay = preferred === 'relay' || preferred === 'direct_or_relay' || preferred === 'any' || preferred === 'store_and_forward';

    if (tryLanDirectFirst) {
      for (const [id, info] of this._knownPeers) {
        if (connected.has(id)) continue;
        if ((info.failures || 0) > 5) continue;
        const addrs = info.multiaddrs || [];
        for (const ma of addrs) {
          try {
            const full = ma.includes('/p2p/') ? ma : ma + '/p2p/' + id;
            if (full.includes('/p2p-circuit')) continue; // save for relay pass
            checkDial(parseMultiaddr(full), { allowPrivate });
            await this._dialSafe(full);
            break;
          } catch {
            info.failures = (info.failures || 0) + 1;
          }
        }
      }
    }

    if (tryRelay) {
      for (const ra of this._knownRelays) {
        try {
          const pidMatch = /\/p2p\/([^/]+)$/.exec(ra);
          if (pidMatch && connected.has(pidMatch[1])) continue;
          await this._dialSafe(ra);
        } catch { /* ignore */ }
      }
      // Connect known peers via relay as last resort
      for (const [id, info] of this._knownPeers) {
        if (connected.has(id)) continue;
        if ((info.failures || 0) > 8) continue;
        for (const ra of this._knownRelays) {
          try {
            await this.connectViaRelay(id, ra);
            break;
          } catch { /* ignore */ }
        }
      }
    }
  }

  async _dialSafe(multiaddr) {
    if (!this._node) {
      const err = new Error('p2p node is not running');
      err.code = 'E_P2P_NOT_RUNNING';
      throw err;
    }
    try {
      await this._node.dial(multiaddr);
      this._lastDialError = null;
    } catch (e) {
      this._lastDialError = e.message || String(e);
      this.log.debug('p2p dial failed ' + String(multiaddr).slice(0, 60) + ': ' + this._lastDialError);
      throw e;
    }
  }

  async _loadModules({ discovery = false, natRelay = false, lan = false, pubsub = false } = {}) {
    const [
      libp2pMod, wsMod, noiseMod, yamuxMod,
      identifyMod, pingMod, peerIdMod, cryptoMod,
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
    let keysMod = null;
    try { keysMod = await import('@libp2p/crypto/keys'); } catch { /* older layouts */ }
    const k = keysMod || cryptoMod;

    const mods = {
      createLibp2p: libp2pMod.createLibp2p,
      webSockets: wsMod.webSockets,
      noise: noiseMod.noise,
      yamux: yamuxMod.yamux,
      identify: identifyMod.identify,
      ping: pingMod.ping,
      peerIdFromPrivateKey: peerIdMod.peerIdFromPrivateKey,
      peerIdFromString: peerIdMod.peerIdFromString,
      generateKeyPair: k.generateKeyPair || cryptoMod.generateKeyPair,
      privateKeyToProtobuf: k.privateKeyToProtobuf || cryptoMod.privateKeyToProtobuf,
      privateKeyFromProtobuf: k.privateKeyFromProtobuf || cryptoMod.privateKeyFromProtobuf,
    };

    if (discovery) {
      try {
        const dhtMod = await import('@libp2p/kad-dht');
        mods.kadDHT = dhtMod.kadDHT || dhtMod.create || dhtMod.default;
      } catch { /* optional */ }
      try {
        const bootMod = await import('@libp2p/bootstrap');
        mods.bootstrap = bootMod.bootstrap || bootMod.create || bootMod.default;
      } catch { /* optional */ }
    }

    if (natRelay) {
      try {
        const relayMod = await import('@libp2p/circuit-relay-v2');
        mods.circuitRelayTransport = relayMod.circuitRelayTransport || relayMod.default?.circuitRelayTransport;
        mods.circuitRelayServer = relayMod.circuitRelayServer || relayMod.default?.circuitRelayServer;
      } catch { /* optional */ }
      try {
        const dcutrMod = await import('@libp2p/dcutr');
        mods.dcutr = dcutrMod.dcutr || dcutrMod.default;
      } catch { /* optional */ }
      try {
        const autonatMod = await import('@libp2p/autonat');
        mods.autoNAT = autonatMod.autoNAT || autonatMod.default;
      } catch { /* optional */ }
    }

    if (lan) {
      try {
        const mdnsMod = await import('@libp2p/mdns');
        mods.mdns = mdnsMod.mdns || mdnsMod.default;
      } catch { /* optional */ }
    }

    if (pubsub) {
      try {
        const gsMod = await import('@libp2p/gossipsub');
        mods.gossipsub = gsMod.gossipsub || gsMod.default;
      } catch { /* optional */ }
    }

    const requiredFns = ['createLibp2p', 'webSockets', 'noise', 'yamux', 'identify', 'ping', 'peerIdFromPrivateKey', 'generateKeyPair', 'privateKeyToProtobuf', 'privateKeyFromProtobuf'];
    const absent = requiredFns.filter((n) => typeof mods[n] !== 'function');
    if (absent.length) {
      const e = new Error('libp2p API mismatch, missing exports: ' + absent.join(', '));
      e.code = 'E_P2P_API_MISMATCH';
      throw e;
    }
    return mods;
  }

  async _loadOrCreateKey(mods) {
    fs.mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
    const keyPath = path.join(this.keyDir, 'p2p-peer.pb');
    if (fs.existsSync(keyPath)) {
      try {
        const pk = mods.privateKeyFromProtobuf(fs.readFileSync(keyPath));
        try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
        return { privateKey: pk, peerId: await mods.peerIdFromPrivateKey(pk) };
      } catch (e) {
        const q = keyPath + '.corrupt-' + Date.now();
        try { fs.renameSync(keyPath, q); } catch { /* ignore */ }
        this._note = 'peer key was unreadable; a new Peer ID was created (old file kept as ' + path.basename(q) + ')';
        this.log.warn('p2p: ' + this._note);
      }
    }
    const pk = await mods.generateKeyPair('Ed25519');
    const tmp = keyPath + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(mods.privateKeyToProtobuf(pk)), { mode: 0o600 });
    fs.renameSync(tmp, keyPath);
    return { privateKey: pk, peerId: await mods.peerIdFromPrivateKey(pk) };
  }
}

module.exports = { Libp2pAdapter };
