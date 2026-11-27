'use strict';
// Composition root: builds one Hub instance (own DB, keys, ledger, peer manager, HTTP server).
// Tests create several independent instances in one process; server.js creates exactly one.
const fs = require('fs');
const http = require('http');
const { EventEmitter } = require('events');
const { loadConfig } = require('./config');
const { makeLogger } = require('./util');
const { openDatabase } = require('./db');
const { Keystore } = require('./keystore');
const { Materializer } = require('./materializer');
const { Ledger } = require('./ledger');
const { MediaStore } = require('./media');
const { Social } = require('./social');
const { DirectMessages } = require('./dm');
const { Auth } = require('./auth');
const { App, RateLimiter, staticHandler } = require('./http');
const { HttpTransport } = require('./federation/transport');
const { PeerManager } = require('./federation/peers');
const { PresenceClient } = require('./presence/client');
const { AntiEntropy } = require('./federation/delta');
const { HealingSupervisor } = require('./net/p2p/self-healing');
const { RemoteContent } = require('./presence/remote');
const { createNetworkAdapter } = require('./net/adapter');
const { ZeroConfigEngine } = require('./net/zero-config-engine');
const { detectPublicIp, buildPublicUrl } = require('./net/public-ip');
const { WsGateway } = require('./net/p2p/ws-gateway');
const { SensitiveStore } = require('./net/sensitive-store');
const { P2PFileShareService } = require('./net/p2p/file-share');
const pkg = require('../package.json');
const { parseMultiaddr, checkDial } = require('./net/p2p/policy');
const probeMod = require('./net/p2p/bootstrap/probe');   // called through the module object (test seam)

function createHub(overrides = {}, env = process.env) {
  const cfg = loadConfig(env, overrides);
  const log = overrides.logger || makeLogger(cfg.logLevel);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.uploadDir, { recursive: true });
  const db = openDatabase(cfg.dbFile, log);

  const ks = new Keystore(cfg.keyDir, cfg.keyPassphrase);
  const sensitive = new SensitiveStore(db, ks.kek);
  db._sensitive = sensitive;
  try { sensitive.migrateKeys(['public_url_override', 'custom_seeds', 'intro_peer']); } catch (_) {}
  try {
    const ov = sensitive.get('public_url_override');
    if (ov) cfg.publicUrl = String(ov).replace(/\/+$/, '');
  } catch (_) {}

  const bus = new EventEmitter(); bus.setMaxListeners(200);
  const mat = new Materializer(db, bus);
  const ledger = new Ledger(db, ks, mat, log);
  ledger.bus.on('events', (e) => bus.emit('events', e));
  // hub-level moderation: accounts the owner blocked are not ingested from peers at all
  ledger.isBlocked = (actor) => !!db.get('SELECT 1 x FROM blocks b JOIN users u ON u.id=b.user_id AND u.is_primary=1 WHERE b.account_id=? LIMIT 1', actor);
  const media = new MediaStore(db, cfg, log);
  const auth = new Auth(db, cfg);
  const social = new Social({ db, ledger, ks, media, cfg, bus, auth });
  const limiter = new RateLimiter();
  const app = new App({ config: cfg, log, limiter });
  auth.installHooks(app);
  app.hooks.static = staticHandler(cfg.publicDir);
  const transport = overrides.transport || new HttpTransport({ allowPrivate: cfg.allowPrivatePeers, timeoutMs: cfg.peerTimeoutMs });
  const peers = new PeerManager({ db, ledger, ks, cfg, log, transport, media, bus });
  // Global Presence (tiny signed registration with directory seeds) + on-demand remote content (bounded cache).
  const presence = new PresenceClient({ db, ks, cfg, log, transport, self: () => peers.self() });
  presence.contentMode = () => peers.contentMode();
  const remote = new RemoteContent({ db, cfg, log, peers, presence, ledger });
  peers.remoteCache = remote; // discovery cache for events outside my interest scope
  peers.antiEntropy = new AntiEntropy({ peers, ledger, db, log, intervalMs: cfg.antiEntropyMs });
  bus.on('local-publish', () => peers.poke());

  const healing = new HealingSupervisor({ db, ledger, peers, remote, log, cfg: cfg.healing });
  const hub = { cfg, log, db, ks, sensitive, bus, mat, ledger, media, social, dm: null, fileShare: null, auth, limiter, app, transport, peers, presence, remote, healing, timers: [], version: pkg.version, sse: new Set(), sseUsers: new Map(), startedAt: Date.now() };
  hub.dm = new DirectMessages(hub);
  hub.fileShare = new P2PFileShareService(hub);
  // Phase 1 Network Adapter foundation (HTTPS today; libp2p later). Social/Ledger never depend on libp2p directly.
  hub.net = createNetworkAdapter(hub);
  hub._bridgeDiscoveredPeers = (entries = []) => {
    try {
      if (!cfg.federationEnabled || !peers.enabled || !Array.isArray(entries) || !entries.length) return 0;
      if (peers.networkMode && peers.networkMode() === 'private') return 0;
      const nj = db.get("SELECT value FROM meta WHERE key='network_join'")?.value;
      if (nj === 'off') return 0;
      const self = peers.self();
      let selfOrigin = null;
      try { if (self && self.endpoint) selfOrigin = new URL(self.endpoint).origin; } catch {}
      const selfPubHost = String(cfg.publicIp || '').trim();
      const selfPubPort = Number((cfg.p2p && cfg.p2p.publicPort) || hub.port || 0);
      const limit = Math.max(20, Number(cfg.maxPeers) || 50);
      let added = 0;
      for (const item of entries.slice(0, limit)) {
        let epRaw = typeof item === 'string' ? item : (item && item.endpoint);
        if (!epRaw && item && Array.isArray(item.multiaddrs)) {
          for (const ma of item.multiaddrs) {
            try {
              const a = parseMultiaddr(String(ma));
              checkDial(a, { allowPrivate: !!cfg.allowPrivatePeers });
              const host = a.hostType === 'ip6' ? '[' + a.host + ']' : a.host;
              epRaw = (a.secure ? 'https://' : 'http://') + host + ':' + a.port;
              break;
            } catch { /* skip unroutable multiaddr */ }
          }
        }
        if (!epRaw) continue;
        try {
          const u = new URL(String(epRaw));
          if (selfOrigin && u.origin === selfOrigin) continue;
          const epPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
          if (selfPubHost && u.hostname === selfPubHost && selfPubPort && epPort === selfPubPort) continue;
          // Evict oldest offline auto-discovered peer if peer capacity is full
          if (db.get('SELECT COUNT(*) c FROM peers').c >= cfg.maxPeers) {
            const stale = db.get("SELECT id FROM peers WHERE state IN ('bootstrap','discovered') AND fail_streak >= 3 ORDER BY COALESCE(last_ok, 0) ASC, created_at ASC LIMIT 1");
            if (stale) db.run('DELETE FROM peers WHERE id=?', stale.id);
          }
          const p = peers.add(u.origin, { state: 'bootstrap', name: (item && item.name) || null });
          if (p) {
            added++;
            if (p.state !== 'blocked' && !peers.optedOut(p.id) && (!p.last_ok || p.next_retry_at <= Date.now()) && !peers.inflight.has(p.id)) {
              peers.syncPeer(p).catch(() => {});
            }
          }
        } catch { /* ignore self, invalid, or duplicate */ }
      }
      return added;
    } catch { return 0; }
  };
  hub.bridgeCachedDirectoryPeers = () => {
    try {
      if (peers.networkMode && peers.networkMode() === 'private') return 0;
      const { endpointForPeer } = require('./net/p2p/bootstrap/peer-crawl');
      const cached = [];
      const seenEp = new Set();
      const pushCand = (ep, peerId, multiaddrs, name) => {
        if (!ep || seenEp.has(ep)) return;
        seenEp.add(ep);
        cached.push({ endpoint: ep, peerId: peerId || null, multiaddrs: multiaddrs || [], name: name || null });
      };
      try {
        for (const r of db.all('SELECT peer_id, record FROM p2p_peer_registry LIMIT 100')) {
          let rec = {};
          try { rec = JSON.parse(r.record || '{}'); } catch {}
          const ep = rec.endpoint || endpointForPeer(rec);
          if (ep) pushCand(ep, r.peer_id, rec.multiaddrs, rec.name);
        }
      } catch {}
      try {
        for (const r of db.all('SELECT peer_id, multiaddrs, endpoint FROM p2p_known_peers LIMIT 100')) {
          let mas = [];
          try { mas = JSON.parse(r.multiaddrs || '[]'); } catch {}
          const ep = r.endpoint || endpointForPeer({ multiaddrs: mas });
          if (ep) pushCand(ep, r.peer_id, mas, null);
        }
      } catch {}
      return cached.length ? hub._bridgeDiscoveredPeers(cached) : 0;
    } catch { return 0; }
  };
  if (hub.net) hub.net._onHttpPeers = (entries) => hub._bridgeDiscoveredPeers(entries);
  hub.zce = new ZeroConfigEngine({ hub, log });

  // Receive real-time E2EE DMs sent via libp2p /cannoi/msg/1.0.0 store-and-forward
  if (hub.net && typeof hub.net.onLocalMessage === 'function') {
    hub.net.onLocalMessage((msg) => {
      try {
        if (msg && msg.type === 'cannoi-dm-v1' && msg.payload) hub.dm.receiveEnvelope(msg.payload);
      } catch (e) { log.debug('p2p dm rx: ' + (e && e.message)); }
    });
  }

  // Real-time GossipSub public event dissemination + passive discovery ingest
  if (hub.net && typeof hub.net.subscribe === 'function') {
    let gossipUnsub = null;
    const wireGossip = () => {
      if (gossipUnsub || !hub.net || !hub.net.isEnabled()) return;
      try {
        gossipUnsub = hub.net.subscribe('cannoi/events', (msg) => {
          try {
            const ev = msg && msg.data && msg.data.event;
            if (!ev || !ev.event_id) return;
            const res = remote.cacheEvents([ev]);
            if (res && res.accepted > 0) bus.emit('events', { accepted: res.accepted });
          } catch (e) { log.debug('gossip event rx: ' + (e && e.message)); }
        });
      } catch { /* ignore */ }
    };
    hub._wireGossip = wireGossip;
  }
  ledger.bus.on('events', (e) => {
    try {
      if (!e || e.source !== 'local' || !hub.net || !hub.net.isEnabled() || typeof hub.net.publish !== 'function') return;
      const latest = db.get('SELECT raw FROM events WHERE actor_id=(SELECT account_id FROM users WHERE is_primary=1 LIMIT 1) ORDER BY sequence DESC LIMIT 1');
      if (latest && latest.raw) hub.net.publish('cannoi/events', { event: JSON.parse(latest.raw) }).catch(() => {});
    } catch { /* ignore */ }
  });
  // Public, read-only bootstrap descriptor. It exposes only the public Peer ID and dialable addresses.
  // The actual peer identity is authenticated by libp2p Noise during connection establishment.
  app.get('/p2p/bootstrap', { auth: 'none' }, () => {
    const info = hub.net && typeof hub.net.bootstrapInfo === 'function' ? hub.net.bootstrapInfo() : null;
    return info || { network: 'cannoi', protocol: '1', status: 'p2p-unavailable', peer_id: null, multiaddrs: [] };
  });
  app.post('/p2p/register', { auth: 'none', limit: 'presence', maxBytes: 32768 }, async (ctx) => {
    const record = ctx.body && ctx.body.record;
    if (!record || record.network !== 'cannoi' || typeof record.peer_id !== 'string' || record.peer_id.length < 8 || record.peer_id.length > 128 ||
        !Array.isArray(record.multiaddrs) || record.multiaddrs.length < 1 || record.multiaddrs.length > 8 ||
        !Number.isSafeInteger(record.expires_at) || record.expires_at <= Date.now() || record.expires_at > Date.now() + 7 * 86400000) {
      const { HttpError } = require('./util'); throw new HttpError(400, 'E_P2P_RECORD', 'Invalid bootstrap peer record');
    }
    const validAddrs = record.multiaddrs.every((addr) => {
      if (typeof addr !== 'string' || addr.length >= 512 || !addr.includes('/p2p/' + record.peer_id)) return false;
      try { const parsed = parseMultiaddr(addr); checkDial(parsed, { allowPrivate: false }); return parsed.peerId === record.peer_id; } catch { return false; }
    });
    if (!validAddrs) { const { HttpError } = require('./util'); throw new HttpError(400, 'E_P2P_ADDRESS', 'Invalid peer address'); }
    let probe = { verified: false, reason: 'skipped' };
    try { probe = await probeMod.probePeerRecord(record, { timeoutMs: 4000, sourceIp: ctx.ip }); } catch { probe = { verified: false, reason: 'unreachable' }; }
    if (!probe.verified) {
      return { ok: false, accepted: 0, verified: false, reason: probe.reason || 'unreachable', observed: { ip: ctx.ip || null, peer_id: probe.observed_peer_id || null } };
    }
    record.verified = true;
    const result = hub.net && typeof hub.net.registerBootstrapPeer === 'function' ? hub.net.registerBootstrapPeer(record) : { accepted: 0 };
    return { ok: result.accepted > 0, accepted: result.accepted || 0, verified: true, observed: { ip: ctx.ip || null } };
  });
  for (const r of ['core', 'legacy', 'social', 'media', 'admin', 'federation', 'assistant', 'ai-feedback', 'presence']) require('./routes/' + r)(hub);

  const server = http.createServer({ connectionsCheckingInterval: 5000 }, (req, res) => { app.handle(req, res); });   // enforce header/request timeouts promptly (Node's default check interval is 30 s)
  server.maxConnections = cfg.maxConnections || 512;
  server.maxHeadersCount = 64;
  // Per-IP concurrent raw socket tracking to mitigate connection-exhaustion / Slowloris attacks
  const activeSocketsByIp = new Map();
  const maxSocketsPerIp = cfg.maxSocketsPerIp || 128;
  server.on('connection', (socket) => {
    const ip = socket.remoteAddress || 'unknown';
    const cur = (activeSocketsByIp.get(ip) || 0) + 1;
    if (cur > maxSocketsPerIp) {
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    activeSocketsByIp.set(ip, cur);
    socket.once('close', () => {
      const next = (activeSocketsByIp.get(ip) || 1) - 1;
      if (next <= 0) activeSocketsByIp.delete(ip);
      else activeSocketsByIp.set(ip, next);
    });
  });
  // WebSocket routing for P2P on the EXISTING HTTP port. Attached only when P2P is enabled AND the owner opted in (P2P_WS_GATEWAY=true).
  hub.wsGateway = new WsGateway({ server, getBackend: () => (hub.net && typeof hub.net.wsBackend === 'function' ? hub.net.wsBackend() : null), log, limiter, trustProxy: cfg.trustProxy, maxTunnels: (cfg.p2p && cfg.p2p.maxTunnels) || 64, perIpPerMin: cfg.rateLimit.p2pws });
  if (cfg.p2p && cfg.p2p.enabled && cfg.p2p.wsGateway) hub.wsGateway.attach();
  server.headersTimeout = 15000; server.requestTimeout = 15 * 60 * 1000; server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 1000;
  hub.server = server;

  hub.start = () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      server.off('error', reject);
      hub.port = server.address().port;
      // Preserve private network isolation across restarts
      if (peers.networkMode && peers.networkMode() === 'private') {
        try {
          if (hub.net && hub.net._bootstrap) {
            const bm = hub.net._bootstrap;
            if (bm._directory) { bm._directory.urls = []; bm._directory._registeredUntil = 0; }
            if (bm.cfg) { bm.cfg.directorySeeds = []; bm.cfg.fixedSeeds = []; }
          }
        } catch {}
      }
      peers.start();
      // Immediately bridge any previously cached Cloudflare/discovered peer HTTP endpoints on boot
      hub.bridgeCachedDirectoryPeers();
      if (cfg.healing && cfg.healing.intervalMs > 0) healing.start({ intervalMs: cfg.healing.intervalMs }); // Phase 7: bounded background audits + automatic repair
      if (!peers.networkMode || peers.networkMode() !== 'private') {
        presence.start(); // background only: an unreachable seed never delays or blocks the local Hub
      }
      // start() is async: a rejection must never become an unhandledRejection (it used to when libp2p was missing)
      Promise.resolve().then(() => hub.net.start()).then(() => {
        try { hub.zce && hub.zce.start(); } catch (e) { log.warn('zce: ' + (e && e.message)); }
        try { hub._wireGossip && hub._wireGossip(); } catch (_) {}
      }).catch((e) => log.warn('network adapter start: ' + (e && e.message)));
      // Zero-config: auto-detect public IP and fill publicUrl for P2P multiaddrs (no operator input).
      Promise.resolve().then(async () => {
        try {
          if (cfg.disablePublicIpDetection || (cfg.publicUrl && cfg.publicIp)) return;
          const ip = await detectPublicIp({ dataDir: cfg.dataDir, envIp: cfg.publicIp });
          if (!ip) { log.info('public IP not detected yet — P2P LAN/mDNS still works; WAN dial needs connectivity'); return; }
          cfg.publicIp = ip;
          const port = (cfg.p2p && cfg.p2p.publicPort) || 8181;
          if (!cfg.publicUrl) cfg.publicUrl = buildPublicUrl(ip, port, false);
          log.info('public endpoint auto: ' + cfg.publicUrl);
          if (hub.net && typeof hub.net.refreshPublicEndpoint === 'function') {
            try { hub.net.refreshPublicEndpoint({ publicUrl: cfg.publicUrl, publicIp: ip }); } catch (_) {}
          }
        } catch (e) { log.warn('public IP detect: ' + (e && e.message)); }
      });
      resolve(hub.port);
    });
  });
  hub.stop = async () => {
    if (hub.stopping) return hub.stopping;
    hub.stopping = (async () => {
      peers.stop(); healing.stop(); presence.stop(); try { hub.wsGateway.close(); } catch { /* ignore */ } try { await hub.net.stop(); } catch { /* ignore */ } hub.timers.forEach((t) => clearInterval(t));
      for (const r of hub.sse) { try { r.end(); } catch { /* closed */ } }
      hub.sse.clear();
      await new Promise((resolve) => { const t = setTimeout(() => { server.closeAllConnections?.(); resolve(); }, 3000); t.unref(); server.close(() => { clearTimeout(t); resolve(); }); server.closeIdleConnections?.(); });
      try { ledger.checkpoint(); } catch { /* best effort */ }
      db.close();
    })();
    return hub.stopping;
  };
  return hub;
}
module.exports = { createHub };
