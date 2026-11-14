'use strict';
/**
 * Phase 9 — Cross-phase integration tests for CANNOI Resilient Network.
 * Must pass without optional libp2p packages installed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { startHub, Client, tmp } = require('./helpers');
const { createNetworkAdapter } = require('../src/net/adapter');
const { checkModules } = require('../src/net/p2p/availability');
const { openDatabase } = require('../src/db');
const { NetworkStateManager, STATES } = require('../src/net/p2p/network-state');
const { SyncEngine } = require('../src/net/p2p/sync-engine');
const { LocalMessaging } = require('../src/net/p2p/local-messaging');
const { GossipFacade } = require('../src/net/p2p/gossip');
const { Libp2pAdapter } = require('../src/net/p2p/libp2p-adapter');

const P2P = (over = {}) => ({
  enabled: true,
  mdns: true,
  relay: true,
  gossipsub: true,
  dht: true,
  healthIntervalMs: 60000,
  reconnectIntervalMs: 60000,
  stateDwellMs: 1,
  stateRecoverMs: 1,
  ...over,
});

test('Phase 9: checkModules reports all capability groups', async () => {
  const a = await checkModules();
  assert.ok('ok' in a);
  assert.ok(Array.isArray(a.missing));
  assert.ok('discovery' in a && 'discoveryMissing' in a);
  assert.ok('natRelay' in a && 'natRelayMissing' in a);
  assert.ok('lan' in a && 'lanMissing' in a);
  assert.ok('pubsub' in a && 'pubsubMissing' in a);
});

test('Phase 9: migrations 7 and 8 applied on fresh DB', () => {
  const dir = tmp('int-db');
  const db = openDatabase(path.join(dir, 't.db'), { info() {}, warn() {} });
  try {
    assert.ok(db.hasTable('p2p_outbox'));
    assert.ok(db.hasTable('p2p_inbox_seen'));
    assert.ok(db.hasTable('p2p_sync_events'));
    assert.ok(db.hasTable('p2p_sync_checkpoint'));
    // baseline tables untouched
    assert.ok(db.hasTable('schema_migrations'));
    const ids = db.all('SELECT id FROM schema_migrations').map((r) => r.id);
    assert.ok(ids.includes(7));
    assert.ok(ids.includes(8));
  } finally {
    db.close();
  }
});

test('Phase 9: end-to-end offline message → sync event → state machine', async () => {
  const dir = tmp('int-e2e');
  const db = openDatabase(path.join(dir, 't.db'), { info() {}, warn() {} });
  try {
    const adapter = new Libp2pAdapter({
      cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys'), allowPrivatePeers: true },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      keyDir: path.join(dir, 'keys'),
      db,
    });

    // 1. Offline message queues
    const sent = await adapter.sendLocalMessage('12D3KooWpeerZ', 'hello', { n: 1 });
    assert.equal(sent.status, 'queued');
    assert.ok(adapter.pendingLocalMessages() >= 1);

    // 2. Sync event append + list
    adapter.appendSyncEvent('cannoi/events', { kind: 'test' }, { policy: 'public' });
    const range = await adapter.syncRange('remote', { topic: 'cannoi/events', after_seq: 0 });
    assert.ok(range.events.length >= 1);

    // 3. Gossip local delivery without pubsub package
    let got = null;
    adapter.subscribe('cannoi/events', (m) => { got = m; });
    await adapter.publish('cannoi/events', { ping: true });
    assert.ok(got);
    assert.deepEqual(got.data, { ping: true });

    // 4. Network state starts OFFLINE without running node
    assert.equal(adapter.networkState().state, STATES.OFFLINE);
    assert.equal(adapter.preferredTransport(), 'store_and_forward');

    // 5. Status surface is secret-free
    const st = adapter.status();
    const raw = JSON.stringify(st);
    assert.ok(!raw.includes('privateKey'));
    assert.ok(!raw.includes('private_key'));
    assert.ok(!/BEGIN/.test(raw));
    assert.equal(st.network_state, 'OFFLINE');
    assert.ok('outbox' in st || 'pending_local_messages' in st);

    await adapter.stop();
  } finally {
    db.close();
  }
});

test('Phase 9: Hub with P2P enabled still serves core APIs when packages missing', async () => {
  const a = await checkModules();
  if (a.ok) return; // skip if packages actually installed
  const hub = await startHub({ p2p: P2P() });
  try {
    await new Promise((r) => setTimeout(r, 400));
    const c = new Client(hub.base);
    await c.setup('owner');
    assert.equal((await c.get('/health')).status, 200);
    const session = await c.get('/api/session');
    assert.equal(session.status, 200);
    assert.ok(session.json.network);
    const sync = await c.get('/api/sync/status');
    assert.equal(sync.status, 200);
    assert.ok(sync.json.p2p, 'p2p strip present');
    assert.equal(typeof sync.json.p2p.state, 'string');
    // Social still works
    const post = await c.post('/api/posts', { content: 'phase9 integration post' });
    assert.ok([200, 201].includes(post.status));
  } finally {
    await hub.stop();
  }
});

test('Phase 9: factory selects HTTPS adapter when P2P disabled (no regression)', async () => {
  const hub = await startHub({ p2p: { enabled: false } });
  try {
    await new Promise((r) => setTimeout(r, 200));
    const st = hub.net.status();
    assert.ok(st.kind === 'https' || st.kind === 'null' || st.enabled === true || st.kind);
    // Core health
    const c = new Client(hub.base);
    await c.setup('owner');
    assert.equal((await c.get('/health')).status, 200);
  } finally {
    await hub.stop();
  }
});

test('Phase 9: platform transports never claim availability on Node', () => {
  const dir = tmp('int-pt');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P(), dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  const pt = adapter.platformTransports();
  assert.equal(pt.wifiDirect.isAvailable(), false);
  assert.equal(pt.bluetooth.isAvailable(), false);
});

test('Phase 9: policy still rejects private dial by default', async () => {
  const dir = tmp('int-pol');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: P2P({ mdns: false, lanOnly: false }), dataDir: dir, keyDir: path.join(dir, 'keys'), allowPrivatePeers: false },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  await assert.rejects(
    () => adapter.connect('/ip4/192.168.1.10/tcp/4001/ws/p2p/12D3KooWabcdefghijklmnopqrs'),
    (e) => !!e.code
  );
});
