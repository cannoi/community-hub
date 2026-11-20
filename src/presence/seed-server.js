'use strict';
// Stand-alone CANNOI rendezvous seed: /presence/v1/*, /p2p/bootstrap, /p2p/register and /health.
// No UI, accounts, feeds, media, user keys or social content. Suitable for a small VPS.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../config');
const { makeLogger } = require('../util');
const { Db } = require('../db');
const { App, RateLimiter } = require('../http');
const { Directory } = require('./directory');
const { mountDirectoryRoutes } = require('./routes');
const { mountBootstrapSeedRoutes } = require('../net/p2p/bootstrap/seed-routes');
const pkg = require('../../package.json');

function createSeed(env = process.env, overrides = {}) {
  const cfg = loadConfig(env, overrides);
  const log = overrides.logger || makeLogger(cfg.logLevel);
  const file = path.resolve(env.PRESENCE_DB || path.join(cfg.dataDir, 'presence.db'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Db(file);
  const limiter = new RateLimiter();
  const app = new App({ config: cfg, log, limiter });
  const directory = new Directory(db, { maxEntries: cfg.presence.maxEntries, onlineMs: cfg.presence.onlineMs, retainMs: cfg.presence.retainMs, allowPrivate: cfg.allowPrivatePeers });
  mountDirectoryRoutes(app, { directory, limiter, cfg, version: pkg.version });
  const peerRegistry = mountBootstrapSeedRoutes(app, { db, limiter, version: pkg.version });
  app.get('/health', { auth: 'none' }, () => ({ status: 'ok', role: 'presence-seed', timestamp: new Date().toISOString() }));
  const server = http.createServer((req, res) => { app.handle(req, res); });
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.keepAliveTimeout = 5000;
  const timer = setInterval(() => { try { directory.prune(); } catch { /* ignore */ } }, 3600000); timer.unref();
  const seed = { cfg, db, directory, peerRegistry, app, server };
  seed.start = () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, cfg.host, () => { seed.port = server.address().port; resolve(seed.port); }); });
  seed.stop = () => new Promise((resolve) => { clearInterval(timer); const t = setTimeout(() => { server.closeAllConnections?.(); resolve(); }, 2000); t.unref(); server.close(() => { clearTimeout(t); resolve(); }); server.closeIdleConnections?.(); }).then(() => db.close());
  return seed;
}
module.exports = { createSeed };
