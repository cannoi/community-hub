'use strict';
/**
 * Phase 1 — Repair verification for the existing P2P connection layer.
 * These tests do NOT require libp2p packages to be installed.
 * They verify state machine, error codes, status shape, and factory behaviour.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { startHub, Client, waitFor, tmp } = require('./helpers');
const { createNetworkAdapter, HttpsAdapter, NullAdapter } = require('../src/net/adapter');
const { Libp2pAdapter } = require('../src/net/p2p/libp2p-adapter');
const { checkModules } = require('../src/net/p2p/availability');
const { parseMultiaddr, checkDial, P2PAddrError } = require('../src/net/p2p/policy');

const P2P = (over = {}) => ({
  enabled: true,
  maxConnections: 10,
  dialTimeoutMs: 5000,
  bootstrap: [],
  listen: [],
  wsGateway: false,
  ...over,
});

test('Phase 1: factory selects Libp2pAdapter when P2P_ENABLED=true', () => {
  const fake = {
    cfg: { p2p: { enabled: true }, keyDir: path.join(os.tmpdir(), 'p2p-keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    port: 0,
  };
  const a = createNetworkAdapter(fake);
  assert.ok(a instanceof Libp2pAdapter);
  assert.equal(a.kind(), 'p2p');
  assert.equal(a.isEnabled(), true);
});

test('Phase 1: status() never exposes private key material and has stable shape', async () => {
  const dir = tmp('p2p-st');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys'), allowPrivatePeers: true },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
    httpPort: () => 0,
  });
  const st = adapter.status();
  assert.equal(st.kind, 'p2p');
  assert.equal(st.enabled, true);
  assert.equal(st.state, 'stopped');
  assert.equal(st.peer_id, null);
  assert.equal(st.peers, 0);
  assert.ok('listeners' in st);
  // Must never contain key material
  const raw = JSON.stringify(st);
  assert.ok(!/BEGIN|PRIVATE|protobuf|-----/.test(raw));
});

test('Phase 1: connect() rejects invalid addresses with stable code before touching node', async () => {
  const dir = tmp('p2p-conn');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys'), allowPrivatePeers: true },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  // Invalid address → policy error, not a silent no-op
  await assert.rejects(
    () => adapter.connect('not-a-multiaddr'),
    (e) => e.code === 'E_P2P_BAD_ADDR' || e.name === 'P2PAddrError' || /multiaddr|E_P2P/.test(String(e.message || e.code))
  );
  // Empty / null → also rejected
  await assert.rejects(() => adapter.connect(null));
  await assert.rejects(() => adapter.connect(''));
});

test('Phase 1: connect() while node is stopped raises E_P2P_NOT_RUNNING', async () => {
  const dir = tmp('p2p-nr');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys'), allowPrivatePeers: true },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  // Valid-looking public multiaddr, but node not started
  await assert.rejects(
    () => adapter.connect('/ip4/8.8.8.8/tcp/443/wss'),
    (e) => e.code === 'E_P2P_NOT_RUNNING'
  );
});

test('Phase 1: start() without libp2p packages reaches "unavailable" and does not crash', async () => {
  const a = await checkModules();
  const dir = tmp('p2p-unavail');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys'), allowPrivatePeers: true },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
    httpPort: () => 0,
  });
  // Directly start the adapter (no Hub fire-and-forget race)
  await adapter.start();
  const st = adapter.status();
  assert.equal(st.kind, 'p2p');
  if (!a.ok) {
    assert.equal(st.state, 'unavailable');
    assert.ok(Array.isArray(st.missing) && st.missing.length > 0, 'missing packages listed');
    assert.equal(st.peer_id, null);
  } else {
    // Packages present — accept running or error (environment may still fail createLibp2p)
    assert.ok(['running', 'error', 'unavailable'].includes(st.state), 'got ' + st.state);
  }
  // Idempotent second start + clean stop
  await adapter.start();
  await adapter.stop();
  assert.equal(adapter.status().state, 'stopped');
});

test('Phase 1: stop() is safe from any state and leaves state=stopped', async () => {
  const dir = tmp('p2p-stop');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  await adapter.stop(); // from stopped
  assert.equal(adapter.status().state, 'stopped');
  await adapter.start(); // may become unavailable
  await adapter.stop();
  assert.equal(adapter.status().state, 'stopped');
  await adapter.stop(); // second stop is no-op
  assert.equal(adapter.status().state, 'stopped');
});

test('Phase 1: listPeers() returns [] when not running', async () => {
  const dir = tmp('p2p-lp');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  const peers = await adapter.listPeers();
  assert.deepEqual(peers, []);
});

test('Phase 1: default Hub still uses HTTPS adapter (P2P off)', async () => {
  const hub = await startHub();
  try {
    assert.equal(hub.net.kind(), 'https');
    assert.ok(hub.net instanceof HttpsAdapter);
    const c = new Client(hub.base);
    await c.setup('owner');
    const sess = (await c.get('/api/session')).json;
    assert.equal(sess.network.kind, 'https');
  } finally {
    await hub.stop();
  }
});

test('Phase 1: policy still rejects private dial targets by default', () => {
  assert.throws(() => checkDial('/ip4/127.0.0.1/tcp/4001/ws'), (e) => e.code === 'E_P2P_PRIVATE_ADDR');
  assert.throws(() => checkDial('/ip4/10.0.0.1/tcp/4001/ws'), (e) => e.code === 'E_P2P_PRIVATE_ADDR');
  assert.ok(checkDial('/ip4/8.8.8.8/tcp/443/wss'));
});
