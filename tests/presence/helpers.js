'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const { startHub, Client, waitFor, tmp, PNG, formWith } = require('../helpers');
const { createSeed } = require('../../src/presence/seed-server');
const { HttpTransport } = require('../../src/federation/transport');

const presenceCfg = (over = {}) => ({ enabled: true, seeds: [], serve: false, heartbeatMs: 400, timeoutMs: 800, onlineMs: 5000, retainMs: 1e9, maxEntries: 1000, region: '', ...over });

/** Transport that records every outbound request path (so tests can prove what did NOT happen). */
class SpyTransport extends HttpTransport {
  constructor(o) { super({ allowPrivate: true, timeoutMs: 2000, ...o }); this.calls = []; const r = this.request.bind(this); this.request = (ep, opts, max) => { this.calls.push((opts.method || 'GET') + ' ' + opts.path); return r(ep, opts, max); }; }
  count(re) { return this.calls.filter((c) => re.test(c)).length; }
}

async function startSeed(over = {}) {
  const dir = tmp('seed');
  const seed = createSeed({ PRESENCE_DB: path.join(dir, 'p.db'), PORT: '0', HOST: '127.0.0.1' }, { allowPrivatePeers: true, logger: { error() {}, warn() {}, info() {}, debug() {} }, ...over });
  await seed.start(); seed.base = `http://127.0.0.1:${seed.port}`; return seed;
}

async function mkHub(name, { seeds = [], content, extra = {}, display } = {}) {
  const transport = new SpyTransport();
  const hub = await startHub({ transport, presence: presenceCfg({ seeds }), contentSync: content || 'off', ...extra });
  hub.cfg.publicUrl = hub.base; hub.spy = transport;
  hub.owner = new Client(hub.base); await hub.owner.setup(name, 'correct-horse-9', display ? { display_name: display } : {});
  hub.account = (await hub.owner.get('/api/identity')).json.account_id;
  return hub;
}
module.exports = { presenceCfg, SpyTransport, startSeed, mkHub, startHub, Client, waitFor, tmp, PNG, formWith };
