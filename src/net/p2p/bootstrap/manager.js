'use strict';
/**
 * Auto-Bootstrap Manager (Phases 2–8).
 *
 * Workflow:
 *   load identity → known peers → LAN → fixed/libp2p seeds →
 *   HTTPS manifest → DNS → connect verified CANNOI peers →
 *   register if reachable → peer exchange → continuous health
 *
 * Honest states: never reports NETWORK_JOINED until a real
 * authenticated CANNOI peer connection exists.
 */
const {
  BOOTSTRAP_STATES, PROVIDER_KINDS, NETWORK_ID, PROTOCOL_VERSION,
} = require('./types');
const { PeerDatabase } = require('./peer-db');
const {
  createFixedSeedProvider,
  createKnownPeerProvider,
  createLibp2pBootstrapProvider,
  createHttpsManifestProvider,
  createDnsSeedProvider,
  createMdnsProvider,
  publishPeerRecord,
  normalizeSeed,
} = require('./providers');
const {
  createPeerRecord, signPeerRecord, verifyPeerRecord, PeerRegistry,
} = require('./peer-record');

class BootstrapManager {
  /**
   * @param {{
   *   cfg?: object,
   *   db?: object|null,
   *   log?: object,
   *   getPeerId?: () => string|null,
   *   getMultiaddrs?: () => string[],
   *   getLanPeers?: () => object[],
   *   getReachability?: () => string,
   *   getConnectedPeerIds?: () => string[],
   *   dial?: (multiaddr: string) => Promise<void>,
   *   sign?: (payload: string) => string,
   * }} opts
   */
  constructor(opts = {}) {
    this.cfg = opts.cfg || {};
    this.log = opts.log || { debug() {}, info() {}, warn() {}, error() {} };
    this.getPeerId = opts.getPeerId || (() => null);
    this.getMultiaddrs = opts.getMultiaddrs || (() => []);
    this.getLanPeers = opts.getLanPeers || (() => []);
    this.getReachability = opts.getReachability || (() => 'unknown');
    this.getConnectedPeerIds = opts.getConnectedPeerIds || (() => []);
    this.dial = opts.dial || null;
    this.sign = opts.sign || null;

    this.peerDb = new PeerDatabase({ db: opts.db, log: this.log });
    this.registry = new PeerRegistry({ db: opts.db, log: this.log });

    this._state = BOOTSTRAP_STATES.NETWORK_INITIALIZING;
    this._providers = [];
    this._timer = null;
    this._running = false;
    this._lastDiscoveryAt = 0;
    this._lastRegistrationAt = 0;
    this._bootstrapConnected = 0;
    this._cannoiPeersDiscovered = 0;
    this._cannoiPeersConnected = 0;
    this._failedAttempts = 0;
    this._localRecord = null;
    this._cycle = 0;
  }

  state() { return this._state; }

  status() {
    return {
      state: this._state,
      network: NETWORK_ID,
      protocol: PROTOCOL_VERSION,
      providers: this._providers.map((p) => p.status()),
      known_peers: this.peerDb.size(),
      registry_peers: this.registry.size(),
      bootstrap_connected: this._bootstrapConnected,
      cannoi_discovered: this._cannoiPeersDiscovered,
      cannoi_connected: this._cannoiPeersConnected,
      failed_attempts: this._failedAttempts,
      last_discovery_at: this._lastDiscoveryAt || null,
      last_registration_at: this._lastRegistrationAt || null,
      local_record: this._localRecord ? {
        peer_id: this._localRecord.peer_id,
        reachability: this._localRecord.reachability,
        expires_at: this._localRecord.expires_at,
        multiaddrs: this._localRecord.multiaddrs,
      } : null,
      cycle: this._cycle,
    };
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._state = BOOTSTRAP_STATES.NETWORK_INITIALIZING;
    this._initProviders();
    // Non-blocking first cycle
    setImmediate(() => this.runCycle().catch((e) => this.log.debug('bootstrap cycle: ' + (e && e.message))));
    const interval = Number(this.cfg.bootstrapIntervalMs) > 0 ? Number(this.cfg.bootstrapIntervalMs) : 30000;
    this._timer = setInterval(() => {
      this.runCycle().catch((e) => this.log.debug('bootstrap cycle: ' + (e && e.message)));
    }, interval);
    if (this._timer.unref) this._timer.unref();
    this.log.info('bootstrap manager started (' + this._providers.filter((p) => p.isEnabled()).length + ' providers enabled)');
  }

  stop() {
    this._running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _initProviders() {
    const p2p = this.cfg;
    const fixed = Array.isArray(p2p.fixedSeeds) ? p2p.fixedSeeds : [];
    const httpsUrls = Array.isArray(p2p.httpsSeedManifests) ? p2p.httpsSeedManifests : [];
    const dnsDomains = Array.isArray(p2p.dnsSeeds) ? p2p.dnsSeeds : [];
    const libp2pAddrs = Array.isArray(p2p.bootstrap) ? p2p.bootstrap : [];

    this._providers = [
      createKnownPeerProvider(this.peerDb),
      createFixedSeedProvider(fixed),
      createLibp2pBootstrapProvider(libp2pAddrs),
      createHttpsManifestProvider(httpsUrls, { log: this.log }),
      createDnsSeedProvider(dnsDomains, { log: this.log }),
      createMdnsProvider(() => this.getLanPeers()),
    ];
  }

  async runCycle() {
    if (!this._running) return;
    this._cycle++;
    this.peerDb.clearExpired();

    // 1. Discover from all providers (parallel, isolated failures)
    const candidates = await this._discoverAll();
    this._lastDiscoveryAt = Date.now();

    const selfId = this.getPeerId() ? String(this.getPeerId()) : null;
    const usable = candidates.filter((c) => !selfId || String(c.peerId) !== selfId);
    const cannoi = usable.filter((c) => c.category === 'cannoi');
    const infra = usable.filter((c) => c.category === 'infrastructure');
    this._cannoiPeersDiscovered = cannoi.length;

    // Persist useful candidates
    for (const c of candidates) {
      this.peerDb.upsert(c);
      if (c.category === 'cannoi' && (c.signature || c.multiaddrs?.length || c.endpoint)) {
        this.registry.put({
          peer_id: c.peerId,
          network: NETWORK_ID,
          protocol: c.protocol || PROTOCOL_VERSION,
          multiaddrs: c.multiaddrs || [],
          capabilities: c.capabilities || [],
          reachability: 'unknown',
          registered_at: Date.now(),
          expires_at: c.expiresAt || (Date.now() + 86400000),
          signature: c.signature || null,
          endpoint: c.endpoint,
        });
      }
    }

    // 2. Attempt dials (bounded)
    let connectedInfra = 0;
    let connectedCannoi = 0;
    if (typeof this.dial === 'function') {
      const toTry = [
        ...cannoi.filter((c) => c.multiaddrs?.length),
        ...infra.filter((c) => c.multiaddrs?.length),
      ].slice(0, 8);
      for (const c of toTry) {
        for (const ma of (c.multiaddrs || []).slice(0, 2)) {
          try {
            await this.dial(ma);
            this.peerDb.markSuccess(c.peerId);
            if (c.category === 'cannoi') connectedCannoi++;
            else connectedInfra++;
            break;
          } catch {
            this.peerDb.markFailure(c.peerId);
            this._failedAttempts++;
          }
        }
      }
    }

    // Count currently connected
    const live = new Set(this.getConnectedPeerIds() || []);
    this._cannoiPeersConnected = [...live].filter((id) => {
      const r = this.peerDb.get(id);
      return r && r.category === 'cannoi';
    }).length;
    this._bootstrapConnected = connectedInfra + connectedCannoi + live.size;

    // 3. Local registration if we have identity
    this._refreshLocalRecord();
    await this._publishLocalRecord();

    // 4. Update honest state
    this._updateState(live.size, connectedInfra, cannoi.length);
  }

  async _discoverAll() {
    const results = await Promise.allSettled(
      this._providers.filter((p) => p.isEnabled()).map((p) => p.discover())
    );
    const out = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) out.push(...r.value);
    }
    // Dedupe
    const map = new Map();
    for (const c of out) {
      if (!c.peerId) continue;
      const prev = map.get(c.peerId);
      if (!prev) { map.set(c.peerId, c); continue; }
      const addrs = new Set([...(prev.multiaddrs || []), ...(c.multiaddrs || [])]);
      prev.multiaddrs = [...addrs].slice(0, 16);
      if (c.category === 'cannoi') prev.category = 'cannoi';
    }
    return [...map.values()];
  }

  async _publishLocalRecord() {
    if (!this._localRecord) return;
    const rawSeeds = Array.isArray(this.cfg.fixedSeeds) ? this.cfg.fixedSeeds : [];
    const urls = rawSeeds.map(normalizeSeed).filter((x) => x && x.endpoint).map((x) => x.endpoint);
    await Promise.allSettled([...new Set(urls)].slice(0, 5).map((url) => publishPeerRecord(url, this._localRecord, 4000)));
  }

  _refreshLocalRecord() {
    const peerId = this.getPeerId();
    if (!peerId) return;
    const reach = this.getReachability();
    const addrs = this.getMultiaddrs() || [];
    let record = createPeerRecord({
      peerId,
      multiaddrs: addrs,
      capabilities: ['hub', 'gossip', 'sync'],
      reachability: reach,
    });
    if (this.sign) record = signPeerRecord(record, this.sign);
    this._localRecord = record;
    this.registry.put(record);
    this._lastRegistrationAt = Date.now();
  }

  _updateState(liveCount, infraConnected, cannoiDiscovered) {
    const reach = this.getReachability();
    const cannoiConnected = this._cannoiPeersConnected;

    // NETWORK_JOINED only with real CANNOI peer connection
    if (cannoiConnected >= 1) {
      this._state = BOOTSTRAP_STATES.NETWORK_JOINED;
      return;
    }
    if (reach === 'public' && (this._localRecord?.multiaddrs?.length > 0)) {
      this._state = BOOTSTRAP_STATES.PUBLICLY_DISCOVERABLE;
      return;
    }
    if (reach === 'private' && infraConnected + liveCount > 0) {
      this._state = BOOTSTRAP_STATES.RELAY_AVAILABLE;
      return;
    }
    if (infraConnected > 0 || liveCount > 0) {
      this._state = BOOTSTRAP_STATES.BOOTSTRAP_CONNECTED;
      return;
    }
    // No authenticated CANNOI peer yet — always wait (never pretend joined)
    this._state = BOOTSTRAP_STATES.WAITING_FOR_FIRST_PEER;
  }

  /** Import external candidates (peer exchange). */
  acceptExchange(records = []) {
    let accepted = 0;
    for (const raw of records) {
      const v = verifyPeerRecord(raw);
      if (!v.ok) continue;
      this.registry.put(raw);
      this.peerDb.upsert({
        peerId: raw.peer_id,
        multiaddrs: raw.multiaddrs || [],
        category: 'cannoi',
        source: PROVIDER_KINDS.EXCHANGE,
        protocol: raw.protocol,
        capabilities: raw.capabilities,
        expiresAt: raw.expires_at,
        signature: raw.signature,
      });
      accepted++;
    }
    return { accepted };
  }

  listRegistry(limit = 50) {
    return this.registry.list(limit);
  }
}

module.exports = { BootstrapManager, BOOTSTRAP_STATES };
