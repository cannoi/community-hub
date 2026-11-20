'use strict';
/**
 * Phase 2 — Automatic peer discovery & Kademlia DHT tests.
 * Runs without real libp2p packages (status/shape checks).
 * Full dial/DHT tests require packages + REQUIRE_P2P=1.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startHub, Client, tmp } = require('./helpers');
const { Libp2pAdapter } = require('../src/net/p2p/libp2p-adapter');
const { checkModules } = require('../src/net/p2p/availability');
const { loadConfig } = require('../src/config');

const P2P = (over = {}) => ({
  enabled: true,
  maxConnections: 10,
  dialTimeoutMs: 5000,
  bootstrap: [],
  listen: [],
  wsGateway: false,
  dht: true,
  healthIntervalMs: 60000,
  reconnectIntervalMs: 60000,
  ...over,
});

test('Phase 2: config exposes DHT and discovery intervals', () => {
  const cfg = loadConfig({
    P2P_ENABLED: 'true',
    P2P_DHT: 'true',
    P2P_DHT_PROTOCOL: '/cannoi/kad/1.0.0',
    P2P_DISCOVER_INTERVAL_MS: '45000',
    P2P_HEALTH_INTERVAL_MS: '20000',
    P2P_RECONNECT_INTERVAL_MS: '12000',
  });
  assert.equal(cfg.p2p.enabled, true);
  assert.equal(cfg.p2p.dht, true);
  assert.equal(cfg.p2p.dhtProtocol, '/cannoi/kad/1.0.0');
  assert.equal(cfg.p2p.discoverIntervalMs, 45000);
  assert.equal(cfg.p2p.healthIntervalMs, 20000);
  assert.equal(cfg.p2p.reconnectIntervalMs, 12000);
});

test('Phase 2: status() includes discovery fields', async () => {
  const dir = tmp('p2p-d2');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys'), allowPrivatePeers: true },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
    httpPort: () => 0,
  });
  const st = adapter.status();
  assert.equal(st.kind, 'p2p');
  assert.ok('discovery' in st);
  assert.ok('known_peers' in st);
  assert.equal(st.known_peers, 0);
  assert.equal(typeof st.discovery, 'boolean');
});

test('Phase 2: checkModules reports discovery packages separately', async () => {
  const a = await checkModules();
  assert.ok('discovery' in a);
  assert.ok(Array.isArray(a.discoveryMissing));
  // Core may or may not be present in this environment
  assert.ok(Array.isArray(a.missing));
});

test('Phase 2: start without packages → unavailable, discovery=false', async () => {
  const a = await checkModules();
  const dir = tmp('p2p-d3');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
    httpPort: () => 0,
  });
  await adapter.start();
  const st = adapter.status();
  if (!a.ok) {
    assert.equal(st.state, 'unavailable');
    assert.equal(st.discovery, false);
  }
  await adapter.stop();
  assert.equal(adapter.status().state, 'stopped');
});

test('Phase 2: listKnownPeers starts empty and is bounded', async () => {
  const dir = tmp('p2p-d4');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  assert.deepEqual(adapter.listKnownPeers(), []);
  // Internal remember
  adapter._rememberPeer('12D3KooWtestpeer00000000000000000001', ['/ip4/1.2.3.4/tcp/4001/ws']);
  const known = adapter.listKnownPeers();
  assert.equal(known.length, 1);
  assert.equal(known[0].id, '12D3KooWtestpeer00000000000000000001');
  assert.ok(known[0].multiaddrs.length >= 1);
});

test('Phase 2: findPeer returns null when DHT not running', async () => {
  const dir = tmp('p2p-d5');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  const r = await adapter.findPeer('12D3KooWaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(r, null);
});

test('Phase 2: Hub with P2P on still serves HTTPS when packages missing', async () => {
  const a = await checkModules();
  if (a.ok) return; // skip if packages present — covered elsewhere
  const hub = await startHub({ p2p: P2P() });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const c = new Client(hub.base);
    await c.setup('owner');
    assert.equal((await c.get('/health')).status, 200);
    const sess = (await c.get('/api/session')).json;
    assert.ok(sess.network);
    assert.equal(sess.network.kind, 'p2p');
  } finally {
    await hub.stop();
  }
});

test('Phase 2: background loops stop cleanly', async () => {
  const dir = tmp('p2p-d6');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P({ healthIntervalMs: 100, reconnectIntervalMs: 100 }), dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  await adapter.start();
  // Even if unavailable, stop must clear timers
  await adapter.stop();
  assert.equal(adapter._healthTimer, null);
  assert.equal(adapter._reconnectTimer, null);
  assert.equal(adapter.status().state, 'stopped');
});
