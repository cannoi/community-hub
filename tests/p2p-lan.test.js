'use strict';
/**
 * Phase 4 — LAN discovery (mDNS) and local messaging tests.
 * Runnable without libp2p / mdns packages.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startHub, Client, tmp } = require('./helpers');
const { Libp2pAdapter } = require('../src/net/p2p/libp2p-adapter');
const { LanRegistry } = require('../src/net/p2p/lan-registry');
const { LocalMessaging } = require('../src/net/p2p/local-messaging');
const { createNullPlatformTransport } = require('../src/net/p2p/platform-transport');
const { checkModules } = require('../src/net/p2p/availability');
const { loadConfig } = require('../src/config');

const P2P = (over = {}) => ({
  enabled: true,
  maxConnections: 10,
  dialTimeoutMs: 5000,
  bootstrap: [],
  listen: [],
  mdns: true,
  relay: true,
  healthIntervalMs: 60000,
  reconnectIntervalMs: 60000,
  ...over,
});

test('Phase 4: config exposes mDNS / LAN options', () => {
  const cfg = loadConfig({
    P2P_ENABLED: 'true',
    P2P_MDNS: 'true',
    P2P_MDNS_INTERVAL_MS: '15000',
    P2P_MDNS_SERVICE_TAG: '_cannoi-hub._udp.local',
    P2P_LAN_ONLY: 'false',
  });
  assert.equal(cfg.p2p.mdns, true);
  assert.equal(cfg.p2p.mdnsIntervalMs, 15000);
  assert.equal(cfg.p2p.mdnsServiceTag, '_cannoi-hub._udp.local');
  assert.equal(cfg.p2p.lanOnly, false);
});

test('Phase 4: LanRegistry tracks peers by source and TTL', () => {
  const reg = new LanRegistry({ maxPeers: 10, ttlMs: 60000 });
  reg.upsert('peer-a', { multiaddrs: ['/ip4/192.168.1.5/tcp/4001/ws'], source: 'mdns' });
  reg.upsert('peer-b', { multiaddrs: ['/ip4/8.8.8.8/tcp/4001/ws'], source: 'dht' });
  assert.equal(reg.size(), 2);
  assert.equal(reg.listLan().length, 1);
  assert.equal(reg.listLan()[0].id, 'peer-a');
  assert.ok(reg.get('peer-a'));
  reg.markFailure('peer-a');
  assert.equal(reg.get('peer-a').failures, 1);
  reg.markSuccess('peer-a');
  assert.equal(reg.get('peer-a').failures, 0);
});

test('Phase 4: LanRegistry respects maxPeers bound', () => {
  const reg = new LanRegistry({ maxPeers: 5, ttlMs: 60000 });
  for (let i = 0; i < 20; i++) {
    reg.upsert('p' + i, { multiaddrs: ['/ip4/10.0.0.' + i + '/tcp/1/ws'], source: 'mdns' });
  }
  assert.ok(reg.size() <= 5);
});

test('Phase 4: platform transports report unavailable on Node backend', async () => {
  const wd = createNullPlatformTransport('wifi-direct');
  const bt = createNullPlatformTransport('bluetooth');
  assert.equal(wd.isAvailable(), false);
  assert.equal(bt.isAvailable(), false);
  await assert.rejects(() => wd.connect({ id: 'x' }), (e) => e.code === 'E_PLATFORM_TRANSPORT_UNAVAILABLE');
  await assert.rejects(() => bt.send('x', new Uint8Array([1])), (e) => e.code === 'E_PLATFORM_TRANSPORT_UNAVAILABLE');
});

test('Phase 4: status includes mdns and lan_peers fields', async () => {
  const dir = tmp('p2p-l1');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
    httpPort: () => 0,
  });
  const st = adapter.status();
  assert.ok('mdns' in st);
  assert.ok('lan_peers' in st);
  assert.ok('pending_local_messages' in st);
  assert.equal(st.lan_peers, 0);
  assert.equal(st.mdns, false); // not started / packages missing
});

test('Phase 4: checkModules reports lan packages', async () => {
  const a = await checkModules();
  assert.ok('lan' in a);
  assert.ok(Array.isArray(a.lanMissing));
});

test('Phase 4: LocalMessaging queues when node is null', async () => {
  const msg = new LocalMessaging({ getNode: () => null });
  const r = await msg.send('12D3KooWtarget', 'ping', { hello: 1 });
  assert.equal(r.status, 'queued');
  assert.equal(msg.pendingCount(), 1);
  const flush = await msg.flush();
  assert.equal(flush.sent, 0);
  assert.equal(flush.remaining, 1);
});

test('Phase 4: adapter sendLocalMessage queues without running node', async () => {
  const dir = tmp('p2p-l2');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  const r = await adapter.sendLocalMessage('12D3KooWsomewhere', 'hello', { n: 1 });
  assert.equal(r.status, 'queued');
  assert.equal(adapter.pendingLocalMessages(), 1);
});

test('Phase 4: listLanPeers starts empty; platformTransports always present', () => {
  const dir = tmp('p2p-l3');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  assert.deepEqual(adapter.listLanPeers(), []);
  const pt = adapter.platformTransports();
  assert.equal(pt.wifiDirect.isAvailable(), false);
  assert.equal(pt.bluetooth.isAvailable(), false);
});

test('Phase 4: Hub healthy with mDNS requested but packages missing', async () => {
  const a = await checkModules();
  if (a.ok) return;
  const hub = await startHub({ p2p: P2P() });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const c = new Client(hub.base);
    await c.setup('owner');
    assert.equal((await c.get('/health')).status, 200);
  } finally {
    await hub.stop();
  }
});
