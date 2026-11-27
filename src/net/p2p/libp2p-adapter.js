'use strict';
const netLog = require('../network-log');
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
const { SelfHealEngine, PEER_LIFECYCLE } = require('./self-heal');
const { normalizeDiscoveryDetail, peerIdFromAddr, multiaddrString } = require('./peer-info');
const { TrustEngine, TRUST } = require('./trust-engine');
const { DistributedIndex } = require('./distributed-index');
const { ShardCoordinator } = require('./index-replication');
const { ResourceGovernor, Libp2pIndexTransport, SEARCH_PROTOCOL } = require('./index-governor');
const { SearchService, FederatedSearch } = require('./federated-search');
const { PostIndexer, createContentProvider } = require('./post-indexer');
const indexCrypto = require('./index-crypto');
const { BootstrapManager } = require('./bootstrap/manager');
const compat = require('./libp2p-compat');

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
    this._dialProblems = new Map();
    this._addressVerified = false;
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
    this._import = opts.importModule || compat.defaultImporter; // injectable for tests
    this._localMessaging = new LocalMessaging({
      toPeer: (id) => compat.toPeerId(id, this._import),
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
    this._onHttpPeers = typeof opts.onHttpPeers === 'function' ? opts.onHttpPeers : null;
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
      onHttpPeers: (list) => { if (typeof this._onHttpPeers === 'function') this._onHttpPeers(list); },
      dial: async (ma) => {
        if (this._state !== 'running' || !this._node) {
          const e = new Error('not running'); e.code = 'E_P2P_NOT_RUNNING'; throw e;
        }
        return this._dialSafe(ma);
      },
    });
    this._healthTimer = null;
    this._reconnectTimer = null;
    this._trust = new TrustEngine({ log: this.log, maxPeers: 500 });
    this._db = opts.db || null;
    this._hub = opts.hub || null; this._search = null; this._searchIndexer = null; this._peerHints = null;
    this._indexCoordinator = null; this._indexTimer = null;
    this._distributedIndex = new DistributedIndex({ db: opts.db || null, localPeerId: () => (this._peerId ? String(this._peerId) : null), log: this.log, maxDocuments: (this.cfg.p2p && this.cfg.p2p.indexMaxDocuments) || 50000, maxBytes: (this.cfg.p2p && this.cfg.p2p.indexMaxBytes) || 64 * 1024 * 1024 });
    this._selfHeal = new SelfHealEngine({
      log: this.log,
      getPublicIp: async () => {
        try {
          const { detectPublicIp } = require('../public-ip');
          if (typeof detectPublicIp === 'function') return await detectPublicIp();
        } catch { /* ignore */ }
        return this.cfg.publicIp || null;
      },
      onIpChanged: async (prev, next) => {
        this.cfg.publicIp = next;
        try {
          if (typeof this.refreshPublicEndpoint === 'function') {
            this.refreshPublicEndpoint({ publicIp: next });
          }
        } catch { /* ignore */ }
        this.log.info('p2p public IP changed ' + prev + ' -> ' + next);
      },
      requestReconnect: () => this._runReconnect(),
      requestRelayPass: async () => {
        // Prefer relay transport for next reconnect cycle
        try {
          if (this._netState && this._netState.forcePreferRelay) this._netState.forcePreferRelay();
        } catch { /* ignore */ }
        await this._runReconnect();
      },
    });
    this._httpPort = typeof opts.httpPort === 'function' ? opts.httpPort : () => Number((this.cfg && this.cfg.port) || 0);
  }

  /** Build a public dial address through the HTTP/WebSocket gateway (port = P2P_PUBLIC_PORT / public URL). */
  _advertisedMultiaddrs() {
    if (!this._peerId) return [];
    const p2pCfg = this.cfg.p2p || {};
    if (!p2pCfg.wsGateway) return [];
    let raw = String(this.cfg.publicUrl || process.env.HUB_PUBLIC_URL || process.env.PUBLIC_URL || '').trim();
    const pubPort = Number(p2pCfg.publicPort || 0);
    const pubIp = String(this.cfg.publicIp || process.env.PUBLIC_IP || '').trim();
    if (!raw && pubIp && pubPort > 0) raw = 'http://' + pubIp + ':' + pubPort;
    if (!raw) return [];
    try {
      const u = new URL(raw);
      if (u.pathname && u.pathname !== '/') return [];
      const secure = u.protocol === 'https:';
      if (!secure && u.protocol !== 'http:') return [];
      let port = u.port ? Number(u.port) : (secure ? 443 : 80);
      if (!u.port) {
        if (!(Number.isInteger(pubPort) && pubPort > 0 && pubPort <= 65535)) return [];
        port = pubPort;
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
      const host = net.isIP(u.hostname) === 4 ? 'ip4' : net.isIP(u.hostname) === 6 ? 'ip6' : 'dns4';
      const transport = secure ? '/tls/ws' : '/ws';
      return [`/${host}/${u.hostname}/tcp/${port}${transport}/p2p/${String(this._peerId)}`];
    } catch { return []; }
  }

  bootstrapInfo() {
    const peerId = this._peerId ? String(this._peerId) : null;
    const multiaddrs = this._advertisedMultiaddrs();
    const p2pCfg = this.cfg.p2p || {};
    return {
      network: 'cannoi', protocol: '1',
      status: this._state === 'running' ? (multiaddrs.length ? 'advertised' : 'address-unverified') : (this._state || 'stopped'),
      peer_id: peerId, multiaddrs,
      peers: this._bootstrap ? this._bootstrap.listRegistry(50) : [],
      p2p_public_port: p2pCfg.publicPort || null,
      address_verified: !!this._addressVerified,
      ws_gateway: !!p2pCfg.wsGateway,
      public_url: this.cfg.publicUrl || null,
      updated_at: new Date().toISOString(),
    };
  }

  refreshPublicEndpoint({ publicUrl, publicIp } = {}) {
    if (publicUrl) this.cfg.publicUrl = String(publicUrl).replace(/\/+$/, '');
    if (publicIp) this.cfg.publicIp = String(publicIp).trim();
    // Re-register bootstrap record with new multiaddrs when running
    try {
      if (this._bootstrap && this._peerId) {
        if (typeof this._bootstrap._refreshLocalRecord === 'function') {
          this._bootstrap._refreshLocalRecord();
        }
        if (typeof this._bootstrap._publishLocalRecord === 'function') {
          this._bootstrap._publishLocalRecord().catch(() => {});
        }
      }
    } catch (_) {}
    return this._advertisedMultiaddrs();
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
      distributed_index: this._distributedIndex ? this._distributedIndex.stats() : undefined,
      index_replication: this._indexCoordinator ? this._indexCoordinator.status({ limit: 20 }) : { enabled: false },
      federated_search: this._search ? { enabled: true, metrics: this._search.fed.metrics, service: this._search.service.metrics, indexer: this._searchIndexer ? this._searchIndexer.stats : undefined } : { enabled: false },
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
      last_dial_error: (peers > 0) ? undefined : (this._lastDialError ? String(this._lastDialError).slice(0, 120) : undefined),
      problems: this._problemsList ? this._problemsList() : [],
      self_heal: this._selfHeal ? this._selfHeal.status() : undefined,
      trust: this._trust ? this._trust.status() : undefined,
      address_verified: !!this._addressVerified,
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
          const norm = normalizeDiscoveryDetail(evt && evt.detail);
          if (!norm || !norm.id) return;
          const id = norm.id;
          const addrs = norm.multiaddrs || [];
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
      try { await this._startIndexReplication(); } catch (e) { this.log.warn('index replication start: ' + (e && e.message)); }
      try { await this._startFederatedSearch(); } catch (e) { this.log.warn('federated search start: ' + (e && e.message)); }
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
      try { this._bootstrap.start(); } catch { /* ignore */ }
    }
  }

  async stop() {
    this._stopBackgroundLoops();
    try { await this._stopFederatedSearch(); } catch { /* ignore */ }
    try { await this._stopIndexReplication(); } catch { /* ignore */ }
    try { await this._localMessaging.stop(); } catch { /* ignore */ }
    try { this._gossip.stop(); } catch { /* ignore */ }
    try { await this._bootstrap.stop(); } catch { /* ignore */ }
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

  // Phase 5: local PUBLIC index and shard coordination primitives.
  indexPublicDocument(document, opts) { return this._distributedIndex.upsertDocument(document, opts || {}); }
  searchLocalIndex(query, opts) { return this._distributedIndex.searchLocal(query, opts || {}); }
  removeIndexedDocument(originPeer, contentId) { return this._distributedIndex.removeDocument(originPeer, contentId); }
  planIndexShardAssignments(shardIds, candidates, opts) { return this._distributedIndex.planAssignments(shardIds, candidates, opts || {}); }
  applyIndexShardManifest(manifest, opts) { return this._distributedIndex.applyShardManifest(manifest, opts || {}); }
  exportIndexShard(shardId, opts) { return this._distributedIndex.exportShard(shardId, opts || {}); }
  importIndexShardSnapshot(snapshot, opts) { return this._distributedIndex.importShardSnapshot(snapshot, opts || {}); }
  indexStats() { return this._distributedIndex.stats(); }

  // Phase 5 completion: live shard replication (opt-in via P2P_INDEX_REPLICATION=1 until the multi-machine gate passes).
  async _startIndexReplication() {
    const p2p = this.cfg.p2p || {};
    if (!p2p.indexReplication || this._indexCoordinator || !this._node || !this._peerId || !this._privateKey || !this._db) return false;
    const trust = { stateOf: (p) => this._trust.stateOf(p), allow: (p, a) => this._trust.allow(p, a), observe: (p, o) => this._trust.observe(p, o) };   // late-bound: the engine can be re-created
    const signer = indexCrypto.createLibp2pSigner({ privateKey: this._privateKey, peerId: String(this._peerId), importer: this._import });
    const transport = new Libp2pIndexTransport({ getNode: () => this._node, toPeer: (id) => compat.toPeerId(id, this._import), log: this.log });
    const governor = new ResourceGovernor({ dataDir: this.cfg.dataDir || '.', index: this._distributedIndex });
    this._indexCoordinator = new ShardCoordinator({ index: this._distributedIndex, db: this._db, transport, signer, localPeerId: String(this._peerId), trust, governor, log: this.log, config: { replicas: p2p.indexReplicas || 3 } });
    await this._indexCoordinator.start();
    this._indexTimer = setInterval(() => { this._indexCoordinator.tick({ candidates: null }).catch((e) => this.log.debug('index tick: ' + (e && e.message))); }, 2000);
    if (this._indexTimer.unref) this._indexTimer.unref();
    return true;
  }
  async _stopIndexReplication() {
    if (this._indexTimer) { clearInterval(this._indexTimer); this._indexTimer = null; }
    if (this._indexCoordinator) { const c = this._indexCoordinator; this._indexCoordinator = null; await c.stop({ graceful: true }); }
  }
  // Phase 6: federated search / Global Explore. Read-only toward the network, bounded, PUBLIC content only.
  async _startFederatedSearch() {
    const p2p = this.cfg.p2p || {};
    if (p2p.federatedSearch === false || this._search || !this._node || !this._peerId || !this._privateKey || !this._db) return false;
    const trust = { stateOf: (p) => this._trust.stateOf(p), allow: (p, a) => this._trust.allow(p, a), observe: (p, o) => this._trust.observe(p, o) };
    const self = String(this._peerId); const presence = this.cfg.presence || {};
    const signer = indexCrypto.createLibp2pSigner({ privateKey: this._privateKey, peerId: self, importer: this._import });
    const transport = new Libp2pIndexTransport({ getNode: () => this._node, toPeer: (id) => compat.toPeerId(id, this._import), log: this.log, protocol: SEARCH_PROTOCOL });
    const governor = new ResourceGovernor({ dataDir: this.cfg.dataDir || '.', index: this._distributedIndex });
    const indexer = new PostIndexer({ db: this._db, index: this._distributedIndex, selfId: () => String(this._peerId || ''), region: presence.region || 'ZZ', log: this.log });
    const contentProvider = createContentProvider({ db: this._db });
    const remote = this._hub && this._hub.remote;
    const service = new SearchService({ index: this._distributedIndex, signer, selfId: self, trust, governor, isStillPublic: (id) => indexer.isStillPublic(id), contentProvider, replicaProvider: remote && remote.cachedPost ? (id) => remote.cachedPost(id) : null, log: this.log });
    const fed = new FederatedSearch({ index: this._distributedIndex, transport, signer, selfId: self, peers: () => this._searchPeers(), trust, governor,
      profile: { region: presence.region || '', languages: presence.languages || ['vi', 'en'] }, contentProvider, contentStore: remote || null, log: this.log,
      verifyEvents: (events) => (remote && typeof remote.cacheEvents === 'function' ? remote.cacheEvents(events) : 0) });
    await transport.start((from, msg) => service.handle(from, msg));
    indexer.start({ bus: this._hub && this._hub.bus });
    if (this._hub && this._hub.healing) this._hub.healing.attachIndexer(indexer);
    this._searchRefresh = setInterval(() => { fed.revalidate({ max: 10 }).catch(() => {}); }, 60000); if (this._searchRefresh.unref) this._searchRefresh.unref();
    this._search = { transport, service, fed, governor };
    this._searchIndexer = indexer;
    return true;
  }
  async _stopFederatedSearch() {
    if (this._searchRefresh) { clearInterval(this._searchRefresh); this._searchRefresh = null; }
    if (this._searchIndexer) { this._searchIndexer.stop(); this._searchIndexer = null; }
    if (this._search) { const s = this._search; this._search = null; try { await s.transport.stop(); } catch { /* ignore */ } }
  }
  /** Routing HINTS only: connected peers + bootstrap registry. Region/languages/topics are used when a record advertises them. */
  _searchPeers() {
    const out = new Map(); const add = (id, rec = {}) => { id = String(id || ''); if (!id || id === String(this._peerId) || out.has(id)) return; out.set(id, { peer_id: id, region: rec.region || 'ZZ', languages: rec.languages || [], topics: rec.topics || [] }); };
    try { for (const c of (this._node && this._node.getConnections ? this._node.getConnections() : [])) add(c.remotePeer); } catch { /* ignore */ }
    try { if (this._bootstrap && this._bootstrap.registry) for (const r of this._bootstrap.registry.list({ limit: 200 })) add(r.peer_id, r); } catch { /* ignore */ }
    if (typeof this._peerHints === 'function') { try { for (const r of this._peerHints() || []) add(r.peer_id, r); } catch { /* ignore */ } }
    for (const id of this._knownPeers.keys()) add(id);
    return [...out.values()].slice(0, 400);
  }
  /** Let the presence/directory layer supply region/languages/topics for routing (optional). */
  setSearchPeerHints(fn) { this._peerHints = typeof fn === 'function' ? fn : null; }
  /** Global Explore API surface (used by routes). Returns null when federated search is not running. */
  get federatedSearch() { return this._search ? this._search.fed : null; }
  searchIndexerSync() { return this._searchIndexer ? this._searchIndexer.syncAll() : null; }

  indexReplicationStatus() { return this._indexCoordinator ? this._indexCoordinator.status() : { enabled: false }; }
  /** Adopt plans from planIndexShardAssignments(); a planned primary then starts its (quorum) election. */
  async adoptIndexAssignments(plans) { return this._indexCoordinator ? this._indexCoordinator.adoptPlan(plans) : []; }
  /** Safe replica repair / rebalance given verified+trusted candidates ({peer_id,verified,trust_state,capacity}). */
  async rebalanceIndex(candidates) { return this._indexCoordinator ? this._indexCoordinator.rebalance(candidates) : { started: [], completed: [], aborted: [] }; }

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
    try { this._selfHeal && this._selfHeal.start(Math.max(15000, reconnectMs)); } catch { /* ignore */ }
  }

  _stopBackgroundLoops() {
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
    if (this._reconnectTimer) { clearInterval(this._reconnectTimer); this._reconnectTimer = null;
    this._trust = new TrustEngine({ log: this.log, maxPeers: 500 });
    this._selfHeal = new SelfHealEngine({
      log: this.log,
      getPublicIp: async () => {
        try {
          const { detectPublicIp } = require('../public-ip');
          if (typeof detectPublicIp === 'function') return await detectPublicIp();
        } catch { /* ignore */ }
        return this.cfg.publicIp || null;
      },
      onIpChanged: async (prev, next) => {
        this.cfg.publicIp = next;
        try {
          if (typeof this.refreshPublicEndpoint === 'function') {
            this.refreshPublicEndpoint({ publicIp: next });
          }
        } catch { /* ignore */ }
        this.log.info('p2p public IP changed ' + prev + ' -> ' + next);
      },
      requestReconnect: () => this._runReconnect(),
      requestRelayPass: async () => {
        // Prefer relay transport for next reconnect cycle
        try {
          if (this._netState && this._netState.forcePreferRelay) this._netState.forcePreferRelay();
        } catch { /* ignore */ }
        await this._runReconnect();
      },
    }); }
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

  _classifyDialError(msg) {
    const s = String(msg || '');
    if (/does not match expected remote|peer id.*match|Payload peer id/i.test(s)) return 'wrong_peer';
    if (/same_public_ip/i.test(s)) return 'same_public_ip';
    if (/ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|Could not connect|timed out|timeout/i.test(s)) return 'unreachable';
    if (/protocol|unsupported/i.test(s)) return 'protocol';
    return 'unreachable';
  }

  _recordDialProblem(key, code, message) {
    if (!this._dialProblems) this._dialProblems = new Map();
    this._dialProblems.set(String(key).slice(0, 160), { code, message: String(message).slice(0, 160), at: Date.now() });
    if (this._dialProblems.size > 40) {
      const first = this._dialProblems.keys().next().value;
      this._dialProblems.delete(first);
    }
  }

  _problemsList() {
    if (!this._dialProblems) return [];
    const byCode = new Map();
    for (const [, v] of this._dialProblems) {
      const b = byCode.get(v.code) || { code: v.code, count: 0, sample: v.message, at: v.at };
      b.count++;
      if (v.at > (b.at || 0)) { b.at = v.at; b.sample = v.message; }
      byCode.set(v.code, b);
    }
    return [...byCode.values()].sort((a, b) => b.at - a.at).slice(0, 5);
  }

  /** Parse /ip4|dns4/HOST/tcp/PORT from multiaddr string. */
  _parseHostPort(ma) {
    const parts = String(ma || '').split('/').filter(Boolean);
    let host = null, port = null;
    for (let i = 0; i < parts.length; i++) {
      if ((parts[i] === 'ip4' || parts[i] === 'dns4' || parts[i] === 'dns') && parts[i + 1]) host = parts[i + 1];
      if (parts[i] === 'tcp' && parts[i + 1]) port = Number(parts[i + 1]);
    }
    return { host, port };
  }

  _ownPublicPort() {
    const p2pCfg = this.cfg.p2p || {};
    let port = Number(p2pCfg.publicPort || 0);
    if (!port) {
      try {
        const u = new URL(String(this.cfg.publicUrl || ''));
        if (u.port) port = Number(u.port);
      } catch { /* ignore */ }
    }
    return port || 0;
  }

  /**
   * true = exact self (do not dial).
   * { rewrite } = same public IP, different port → dial via 127.0.0.1 (two Hubs on one machine).
   * false = normal remote dial.
   */
  _isSelfMultiaddr(ma) {
    const s = String(ma || '');
    const selfId = this._peerId ? String(this._peerId) : '';
    if (selfId && s.includes('/p2p/' + selfId)) return true;
    try {
      for (const a of this._advertisedMultiaddrs()) {
        const base = a.replace(/\/p2p\/[^/]+$/, '');
        if (base && s.startsWith(base)) return true;
      }
    } catch { /* ignore */ }
    const pubIp = String(this.cfg.publicIp || process.env.PUBLIC_IP || '').trim();
    const { host, port } = this._parseHostPort(s);
    if (pubIp && host === pubIp && port) {
      const ownPort = this._ownPublicPort();
      if (ownPort && port === ownPort) return true; // same IP+port = self
      // same public IP, other port: hairpin often fails → rewrite to loopback
      const peerPart = (s.match(/\/p2p\/[^/]+/) || [''])[0];
      const rewrite = '/ip4/127.0.0.1/tcp/' + port + '/ws' + peerPart;
      return { rewrite, reason: 'same_public_ip_local' };
    }
    return false;
  }

  async _dialSafe(multiaddr) {
    if (!this._node) {
      const err = new Error('p2p node is not running');
      err.code = 'E_P2P_NOT_RUNNING';
      throw err;
    }
    let maStr = String(multiaddr);
    // Trust gate: extract peer id if present
    try {
      const m = /\/p2p\/([^/]+)/.exec(maStr);
      const pid = m && m[1];
      if (pid && this._trust) {
        const v = this._trust.validatePeerId(pid);
        if (!v.ok) {
          const err = new Error('invalid peer id');
          err.code = 'E_P2P_BAD_PEER';
          throw err;
        }
        const a = this._trust.allow(pid, 'dial');
        if (!a.ok) {
          const err = new Error('trust_denied:' + a.reason);
          err.code = 'E_P2P_TRUST';
          throw err;
        }
      }
    } catch (e) {
      if (e.code === 'E_P2P_TRUST' || e.code === 'E_P2P_BAD_PEER') throw e;
    }
    const self = this._isSelfMultiaddr(maStr);
    if (self === true) {
      const err = new Error('refusing to dial self');
      err.code = 'E_P2P_SELF';
      try { netLog.push('info', 'skip_self', maStr.slice(0, 60)); } catch { /* ignore */ }
      throw err;
    }
    if (self && self.rewrite) {
      try { netLog.push('info', 'local_rewrite', maStr.slice(0, 50) + ' -> ' + self.rewrite.slice(0, 50)); } catch { /* ignore */ }
      maStr = self.rewrite;
    }
    try {
      await this._node.dial(await compat.toMultiaddr(maStr, this._import));
      if (this._dialProblems) this._dialProblems.delete(String(multiaddr).slice(0, 160));
      this._lastDialError = null;
      try { netLog.push('info', 'dial_ok', 'connected ' + maStr.slice(0, 60)); } catch { /* ignore */ }
      try { this._selfHeal && this._selfHeal.noteDialResult(maStr, true); } catch { /* ignore */ }
      try {
        const m = /\/p2p\/([^/]+)/.exec(maStr);
        if (m && this._trust) this._trust.observe(m[1], { success: true });
      } catch { /* ignore */ }
    } catch (e) {
      const msg = e.message || String(e);
      const code = this._classifyDialError(msg);
      this._recordDialProblem(String(multiaddr), code, msg);
      // Do not overwrite global last_dial_error with random registry noise when we already have links
      let peerCount = 0;
      try { peerCount = this._node.getConnections ? this._node.getConnections().length : 0; } catch { /* ignore */ }
      if (peerCount === 0) this._lastDialError = msg;
      if (code === 'wrong_peer') {
        const m = /(?:peer id|Payload peer id)\s+(\w+)/i.exec(msg);
        try {
          if (this._bootstrap && typeof this._bootstrap.noteWrongPeer === 'function') {
            this._bootstrap.noteWrongPeer(String(multiaddr), m && m[1]);
          }
        } catch { /* ignore */ }
      }
      this.log.debug('p2p dial failed ' + maStr.slice(0, 60) + ': ' + msg);
      try { netLog.push('warn', code, 'dial ' + maStr.slice(0, 50) + ': ' + msg.slice(0, 120)); } catch { /* ignore */ }
      try { this._selfHeal && this._selfHeal.noteDialResult(maStr, false); } catch { /* ignore */ }
      try {
        const m = /\/p2p\/([^/]+)/.exec(maStr);
        if (m && this._trust) this._trust.observe(m[1], { failure: true });
      } catch { /* ignore */ }
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
        // @libp2p/gossipsub is pinned to the published 17.2.1 line.
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
