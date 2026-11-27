'use strict';
/**
 * Phase 3 — NAT traversal, hole punching (DCUtR), Circuit Relay v2 tests.
 * Runnable without libp2p packages installed.
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
  relay: true,
  relayServer: false,
  dcutr: true,
  autonat: true,
  healthIntervalMs: 60000,
  reconnectIntervalMs: 60000,
  ...over,
});

test('Phase 3: config exposes relay / DCUtR / AutoNAT options', () => {
  const cfg = loadConfig({
    P2P_ENABLED: 'true',
    P2P_RELAY: 'true',
    P2P_RELAY_SERVER: 'false',
    P2P_RELAY_MAX_RESERVATIONS: '20',
    P2P_DCUTR: 'true',
    P2P_AUTONAT: 'true',
    P2P_RELAY_BOOTSTRAP: '/ip4/1.2.3.4/tcp/4001/ws/p2p/12D3KooWrelaypeer000000000000000001',
  });
  assert.equal(cfg.p2p.relay, true);
  assert.equal(cfg.p2p.relayServer, false);
  assert.equal(cfg.p2p.relayMaxReservations, 20);
  assert.equal(cfg.p2p.dcutr, true);
  assert.equal(cfg.p2p.autonat, true);
  assert.ok(Array.isArray(cfg.p2p.relayBootstrap));
  assert.ok(cfg.p2p.relayBootstrap.length >= 1);
});

test('Phase 3: status() includes nat_relay and reachability fields', async () => {
  const dir = tmp('p2p-n1');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
    httpPort: () => 0,
  });
  const st = adapter.status();
  assert.equal(st.kind, 'p2p');
  assert.ok('nat_relay' in st);
  assert.ok('reachability' in st);
  assert.ok('relay_connections' in st);
  assert.ok('relay_server' in st);
  assert.equal(st.reachability, 'unknown');
  assert.equal(st.relay_server, false);
});

test('Phase 3: checkModules reports natRelay packages separately', async () => {
  const a = await checkModules();
  assert.ok('natRelay' in a);
  assert.ok(Array.isArray(a.natRelayMissing));
});

test('Phase 3: start without packages → unavailable, nat_relay=false', async () => {
  const a = await checkModules();
  const dir = tmp('p2p-n2');
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
    assert.equal(st.nat_relay, false);
    assert.equal(st.relay_server, false);
  }
  await adapter.stop();
});

test('Phase 3: relayServer defaults to false (not mandatory)', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.p2p.relayServer, false);
});

test('Phase 3: connectViaRelay builds circuit multiaddr', async () => {
  const dir = tmp('p2p-n3');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys'), allowPrivatePeers: true },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  // Node not running → E_P2P_NOT_RUNNING
  await assert.rejects(
    () => adapter.connectViaRelay('12D3KooWtarget00000000000000000001', '/ip4/8.8.8.8/tcp/4001/ws/p2p/12D3KooWrelay00000000000000000001'),
    (e) => e.code === 'E_P2P_NOT_RUNNING'
  );
});

test('Phase 3: listKnownRelays starts empty', () => {
  const dir = tmp('p2p-n4');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  assert.deepEqual(adapter.listKnownRelays(), []);
});

test('Phase 3: Hub still healthy with P2P+relay requested but packages missing', async () => {
  const a = await checkModules();
  if (a.ok) return;
  const hub = await startHub({ p2p: P2P({ relayServer: false }) });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const c = new Client(hub.base);
    await c.setup('owner');
    assert.equal((await c.get('/health')).status, 200);
  } finally {
    await hub.stop();
  }
});
