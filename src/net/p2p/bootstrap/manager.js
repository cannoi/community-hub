const netLog = require('../../network-log');
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
const { PeerCrawler, endpointForPeer } = require('./peer-crawl');
const { parseMultiaddr, checkDial } = require('../policy');
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
    this.publishPeerRecord = opts.publishPeerRecord || publishPeerRecord;

    this.peerDb = new PeerDatabase({ db: opts.db, log: this.log });
    this.registry = new PeerRegistry({ db: opts.db, log: this.log });
    this._crawlEnabled = this.cfg.peerCrawl !== false;
    this._crawlPerCycle = Number(this.cfg.crawlPerCycle) > 0 ? Number(this.cfg.crawlPerCycle) : 4;
    this._minPeers = Number(this.cfg.minPeers) > 0 ? Number(this.cfg.minPeers) : 3;
    this._dialBackoff = new Map();
    this._timer = null;
    this._nextDelay = 2500;
    this._crawler = new PeerCrawler({ peerDb: this.peerDb, perCycle: this._crawlPerCycle,
      getConnectedPeerIds: this.getConnectedPeerIds,
      getPeerId: this.getPeerId });

    this._state = BOOTSTRAP_STATES.NETWORK_INITIALIZING;
    this._providers = [];
    this._timer = null;
    this._running = false;
    this._activeCycle = null;
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

  noteWrongPeer(multiaddr, actualPeerId) {
    try { netLog.push('warn', 'wrong_peer', String(multiaddr).slice(0, 60) + ' actual=' + (actualPeerId || '?')); } catch { /* ignore */ }

    try {
      const key = String(multiaddr || '').slice(0, 200);
      this._conflictAddrs = this._conflictAddrs || new Map();
      this._conflictAddrs.set(key, { at: Date.now(), actual: actualPeerId || null });
      // Drop registry entries that advertised this multiaddr with a different peer id
      if (this._registry && typeof this._registry.list === 'function') {
        for (const rec of this._registry.list(100)) {
          const mas = rec.multiaddrs || [];
          if (mas.some((m) => key.includes(String(m).slice(0, 40)) || String(m).includes(key.slice(0, 40)))) {
            if (actualPeerId && rec.peer_id !== actualPeerId) {
              try { this._registry.remove && this._registry.remove(rec.peer_id); } catch { /* ignore */ }
            }
          }
        }
      }
      if (this.log) this.log.debug('wrong_peer at ' + key.slice(0, 50) + ' actual=' + (actualPeerId || '?'));
    } catch { /* ignore */ }
  }

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
    setImmediate(() => this._scheduledCycle());
    this.log.info('bootstrap manager started (' + this._providers.filter((p) => p.isEnabled()).length + ' providers enabled)');
  }

  async stop() {
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    // Do not leave outbound bootstrap/crawl requests alive after Hub shutdown.
    if (this._activeCycle) {
      try { await this._activeCycle; } catch { /* cycle errors are logged by scheduler */ }
      this._activeCycle = null;
    }
  }

  async _scheduledCycle() {
    if (!this._running) return;
    const cycle = this.runCycle();
    this._activeCycle = cycle;
    try { await cycle; } catch (e) { this.log.debug('bootstrap cycle: ' + (e && e.message)); }
    finally { if (this._activeCycle === cycle) this._activeCycle = null; }
    if (!this._running) return;
    const connected = (this.getConnectedPeerIds() || []).length;
    this._nextDelay = connected >= this._minPeers ? 30000 : Math.min(30000, Math.max(5000, this._nextDelay * 2));
    this._timer = setTimeout(() => this._scheduledCycle(), this._nextDelay);
    if (this._timer.unref) this._timer.unref();
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
    if (this._crawlEnabled) {
      try { await this._crawler.crawl(); } catch (e) { this.log.debug('peer crawl: ' + (e && e.message)); }
      for (const c of this.peerDb.asCandidates({ limit: 500 })) {
        if (!candidates.some(x => x.peerId === c.peerId)) candidates.push(c);
      }
    }
    this._lastDiscoveryAt = Date.now();

    const selfId = this.getPeerId() ? String(this.getPeerId()) : null;
    const usable = candidates.filter((c) => !selfId || String(c.peerId) !== selfId);
    const cannoi = usable.filter((c) => c.category === 'cannoi');
    const infra = usable.filter((c) => c.category === 'infrastructure');
    this._cannoiPeersDiscovered = cannoi.length;

    // Persist useful candidates
    for (const c of candidates) {
      // Never persist our own advertised descriptor as a remote peer.
      if (selfId && String(c.peerId) === selfId) continue;
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
          endpoint: endpointForPeer({ multiaddrs: c.multiaddrs }),
        });
      }
    }

    // 2. Smart dialing: skip connected/backoff peers; four concurrent, up to ten while below minPeers.
    let connectedInfra = 0;
    let connectedCannoi = 0;
    if (typeof this.dial === 'function') {
      const liveNow = new Set(this.getConnectedPeerIds() || []);
      const now = Date.now();
      const budget = liveNow.size < this._minPeers ? 10 : 4;
      const toTry = [...cannoi, ...infra].filter(c => c.multiaddrs?.length &&
        !liveNow.has(String(c.peerId)) && (this._dialBackoff.get(String(c.peerId)) || 0) <= now)
        .slice(0, budget);
      for (let i = 0; i < toTry.length; i += 4) {
        const batch = toTry.slice(i, i + 4);
        const outcomes = await Promise.all(batch.map(async c => {
          let ok = false;
          for (const ma of (c.multiaddrs || []).slice(0, 2)) {
            try { await this.dial(ma); ok = true; break; } catch { /* try next address */ }
          }
          if (ok) {
            this.peerDb.markSuccess(c.peerId); this._dialBackoff.delete(String(c.peerId));
            return { category:c.category, ok:true };
          }
          this.peerDb.markFailure(c.peerId);
          if (!this._dialFailures) this._dialFailures = new Map();
          const failures = (this._dialFailures.get(String(c.peerId)) || 0) + 1;
          this._dialFailures.set(String(c.peerId), failures);
          this._dialBackoff.set(String(c.peerId), Date.now() + Math.min(30 * 60 * 1000, 5000 * (2 ** Math.min(8, failures - 1))));
          this._failedAttempts++;
          return { category:c.category, ok:false };
        }));
        for (const o of outcomes) if (o.ok) { if (o.category === 'cannoi') connectedCannoi++; else connectedInfra++; }
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
    // AutoNAT describes the loopback libp2p listener, not the public HTTP/WebSocket
    // gateway. In SoloHost the gateway is the externally dialable transport, so a
    // private AutoNAT result must not suppress publication of a validated public
    // gateway multiaddr. createPeerRecord() has already failed closed on LAN addrs.
    if (!this._localRecord || !Array.isArray(this._localRecord.multiaddrs) || !this._localRecord.multiaddrs.length) return;
    const seedUrls = [];
    const rawSeeds = Array.isArray(this.cfg.fixedSeeds) ? this.cfg.fixedSeeds : [];
    for (const seed of rawSeeds) {
      const normalized = normalizeSeed(seed);
      if (normalized && normalized.endpoint) seedUrls.push(normalized.endpoint.replace(/\/+$/, ''));
    }
    const ownEndpoint = endpointForPeer({ multiaddrs: this._localRecord.multiaddrs });
    const hubUrls = [];
    const selfId = this.getPeerId() ? String(this.getPeerId()) : null;
    const known = this.peerDb.list({ category:'cannoi', limit:100 });
    for (const peer of known) {
      if (selfId && String(peer.peer_id) === selfId) continue;
      const endpoint = endpointForPeer(peer);
      if (endpoint && endpoint !== ownEndpoint && !hubUrls.includes(endpoint)) hubUrls.push(endpoint);
    }
    // Always try configured rendezvous seeds, then at most three known public Hubs.
    const targets = [...new Set(seedUrls.filter(url => url !== ownEndpoint)), ...hubUrls.filter(url => !seedUrls.includes(url)).slice(0, 3)];
    const results = await Promise.allSettled(targets.map(url => this.publishPeerRecord(url, this._localRecord, 4000)));
    if (results.some(result => result.status === 'fulfilled')) this._lastRegistrationAt = Date.now();
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
    for (const item of records) {
      let raw = item;
      const v = verifyPeerRecord(raw);
      if (!v.ok || !Array.isArray(raw.multiaddrs) || !raw.multiaddrs.length) continue;
      const validAddrs = raw.multiaddrs.filter(ma => {
        try { const parsed = parseMultiaddr(ma); checkDial(parsed, { allowPrivate:false }); return parsed.peerId === raw.peer_id; }
        catch { return false; }
      });
      if (!validAddrs.length) continue;
      raw = { ...raw, multiaddrs: validAddrs.slice(0,8) };
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
