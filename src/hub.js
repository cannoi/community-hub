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
const pkg = require('../package.json');
const { parseMultiaddr, checkDial } = require('./net/p2p/policy');
const { probePeerRecord } = require('./net/p2p/bootstrap/probe');

function createHub(overrides = {}, env = process.env) {
  const cfg = loadConfig(env, overrides);
  const log = overrides.logger || makeLogger(cfg.logLevel);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(cfg.uploadDir, { recursive: true });
  const db = openDatabase(cfg.dbFile, log);
  try {
    const ov = db.get("SELECT value FROM meta WHERE key='public_url_override'");
    if (ov && ov.value) cfg.publicUrl = String(ov.value).replace(/\/+$/, '');
  } catch (_) {}

  const ks = new Keystore(cfg.keyDir, cfg.keyPassphrase);
  const bus = new EventEmitter(); bus.setMaxListeners(200);
  const mat = new Materializer(db, bus);
  const ledger = new Ledger(db, ks, mat, log);
  ledger.bus.on('events', (e) => bus.emit('events', e));
  // hub-level moderation: accounts the owner blocked are not ingested from peers at all
  ledger.isBlocked = (actor) => !!db.get('SELECT 1 x FROM blocks b JOIN users u ON u.id=b.user_id AND u.is_primary=1 WHERE b.account_id=? LIMIT 1', actor);
  const media = new MediaStore(db, cfg, log);
  const social = new Social({ db, ledger, ks, media, cfg, bus });
  const auth = new Auth(db, cfg);
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
  const hub = { cfg, log, db, ks, bus, mat, ledger, media, social, auth, limiter, app, transport, peers, presence, remote, healing, timers: [], version: pkg.version, sse: new Set(), startedAt: Date.now() };
  // Phase 1 Network Adapter foundation (HTTPS today; libp2p later). Social/Ledger never depend on libp2p directly.
  hub.net = createNetworkAdapter(hub);
  hub.zce = new ZeroConfigEngine({ hub, log });
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
    try { probe = await probePeerRecord(record, { timeoutMs: 4000, sourceIp: ctx.ip }); } catch { probe = { verified: false, reason: 'unreachable' }; }
    if (!probe.verified) {
      return { ok: false, accepted: 0, verified: false, reason: probe.reason || 'unreachable', observed: { ip: ctx.ip || null, peer_id: probe.observed_peer_id || null } };
    }
    record.verified = true;
    const result = hub.net && typeof hub.net.registerBootstrapPeer === 'function' ? hub.net.registerBootstrapPeer(record) : { accepted: 0 };
    return { ok: result.accepted > 0, accepted: result.accepted || 0, verified: true, observed: { ip: ctx.ip || null } };
  });
  for (const r of ['core', 'legacy', 'social', 'media', 'admin', 'federation', 'assistant', 'ai-feedback', 'presence']) require('./routes/' + r)(hub);

  const server = http.createServer((req, res) => { app.handle(req, res); });
  // WebSocket routing for P2P on the EXISTING HTTP port. Attached only when P2P is enabled AND the owner opted in (P2P_WS_GATEWAY=true).
  hub.wsGateway = new WsGateway({ server, getBackend: () => (hub.net && typeof hub.net.wsBackend === 'function' ? hub.net.wsBackend() : null), log, limiter, trustProxy: cfg.trustProxy, maxTunnels: (cfg.p2p && cfg.p2p.maxTunnels) || 64, perIpPerMin: cfg.rateLimit.p2pws });
  if (cfg.p2p && cfg.p2p.enabled && cfg.p2p.wsGateway) hub.wsGateway.attach();
  server.headersTimeout = 20000; server.requestTimeout = 15 * 60 * 1000; server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 1000;
  hub.server = server;

  hub.start = () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      server.off('error', reject);
      hub.port = server.address().port;
      peers.start();
      if (cfg.healing && cfg.healing.intervalMs > 0) healing.start({ intervalMs: cfg.healing.intervalMs }); // Phase 7: bounded background audits + automatic repair
      presence.start(); // background only: an unreachable seed never delays or blocks the local Hub
      // start() is async: a rejection must never become an unhandledRejection (it used to when libp2p was missing)
      Promise.resolve().then(() => hub.net.start()).then(() => { try { hub.zce && hub.zce.start(); } catch (e) { log.warn('zce: ' + (e && e.message)); } }).catch((e) => log.warn('network adapter start: ' + (e && e.message)));
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
