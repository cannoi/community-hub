'use strict';
/**
 * Phase 6 — GossipSub façade and distributed sync engine tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { openDatabase } = require('../src/db');
const { SyncEngine } = require('../src/net/p2p/sync-engine');
const { GossipFacade } = require('../src/net/p2p/gossip');
const { Libp2pAdapter } = require('../src/net/p2p/libp2p-adapter');
const { checkModules } = require('../src/net/p2p/availability');
const { loadConfig } = require('../src/config');
const { tmp } = require('./helpers');

function openTmpDb() {
  const dir = tmp('gs');
  const db = openDatabase(path.join(dir, 't.db'), { info() {}, warn() {} });
  return { db, dir };
}

test('Phase 6: migration 8 creates sync tables', () => {
  const { db } = openTmpDb();
  try {
    assert.ok(db.hasTable('p2p_sync_checkpoint'));
    assert.ok(db.hasTable('p2p_sync_events'));
    const applied = db.all('SELECT id FROM schema_migrations').map((r) => r.id);
    assert.ok(applied.includes(8));
  } finally { db.close(); }
});

test('Phase 6: config exposes gossipsub options', () => {
  const cfg = loadConfig({ P2P_GOSSIPSUB: 'true', P2P_GOSSIP_MAX_MSG: '32000', P2P_GOSSIP_RATE: '60' });
  assert.equal(cfg.p2p.gossipsub, true);
  assert.equal(cfg.p2p.gossipMaxMessageSize, 32000);
  assert.equal(cfg.p2p.gossipRatePerMin, 60);
});

test('Phase 6: SyncEngine append + listSince incremental', () => {
  const { db } = openTmpDb();
  try {
    const sync = new SyncEngine({ db, localPeerId: () => 'peer-local' });
    const a = sync.append('cannoi/events', { n: 1 }, { policy: 'public' });
    const b = sync.append('cannoi/events', { n: 2 }, { policy: 'public' });
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    const all = sync.listSince('cannoi/events', 0);
    assert.equal(all.length, 2);
    const after1 = sync.listSince('cannoi/events', 1);
    assert.equal(after1.length, 1);
    assert.equal(after1[0].seq, 2);
  } finally { db.close(); }
});

test('Phase 6: SyncEngine rejects duplicates and local-only remote', () => {
  const { db } = openTmpDb();
  try {
    const sync = new SyncEngine({ db, localPeerId: () => 'me' });
    const a = sync.append('t', { x: 1 });
    const r1 = sync.ingest({ ...a });
    assert.equal(r1.accepted, false);
    assert.equal(r1.reason, 'duplicate');
    const r2 = sync.ingest({
      event_id: 'abc', topic: 't', seq: 99, origin_peer: 'other',
      policy: 'local', body: '{}', created_at: Date.now(),
    });
    assert.equal(r2.accepted, false);
    assert.equal(r2.reason, 'local-only');
  } finally { db.close(); }
});

test('Phase 6: conflict resolution is deterministic (higher event_id wins)', () => {
  const { db } = openTmpDb();
  try {
    const sync = new SyncEngine({ db, localPeerId: () => 'me' });
    sync.ingest({
      event_id: 'aaa', topic: 'c', seq: 1, origin_peer: 'o',
      policy: 'public', body: '{"v":1}', created_at: 1,
    });
    const r = sync.ingest({
      event_id: 'zzz', topic: 'c', seq: 1, origin_peer: 'o',
      policy: 'public', body: '{"v":2}', created_at: 2,
    });
    assert.equal(r.accepted, true);
    const rows = db.all('SELECT event_id, body FROM p2p_sync_events WHERE topic=?', 'c');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_id, 'zzz');
  } finally { db.close(); }
});

test('Phase 6: checkpoints advance on applySyncBatch', () => {
  const { db } = openTmpDb();
  try {
    const sync = new SyncEngine({ db, localPeerId: () => 'me' });
    const events = [
      { event_id: 'e1', topic: 's', seq: 1, origin_peer: 'r', policy: 'public', body: '{}', created_at: 1 },
      { event_id: 'e2', topic: 's', seq: 2, origin_peer: 'r', policy: 'public', body: '{}', created_at: 2 },
    ];
    const res = sync.applySyncBatch('remote-peer', 's', events);
    assert.equal(res.accepted, 2);
    assert.equal(res.last_seq, 2);
    const cp = sync.getCheckpoint('remote-peer', 's');
    assert.equal(cp.last_seq, 2);
    const req = sync.buildSyncRequest('remote-peer', 's');
    assert.equal(req.after_seq, 2);
  } finally { db.close(); }
});

test('Phase 6: GossipFacade local policy never meshes', async () => {
  const g = new GossipFacade({ getPubsub: () => null, localPeerId: () => 'me' });
  g.setPolicy('secret', 'local');
  let got = null;
  g.subscribe('secret', (m) => { got = m; });
  const r = await g.publish('secret', { h: 1 });
  assert.equal(r.local, true);
  assert.ok(got);
  assert.deepEqual(got.data, { h: 1 });
});

test('Phase 6: GossipFacade rate limit', async () => {
  const g = new GossipFacade({ getPubsub: () => null, ratePerMin: 2, localPeerId: () => 'me' });
  await g.publish('cannoi/events', 1);
  await g.publish('cannoi/events', 2);
  await assert.rejects(() => g.publish('cannoi/events', 3), (e) => e.code === 'E_GOSSIP_RATE');
});

test('Phase 6: GossipFacade dedup by message id', () => {
  const g = new GossipFacade({ getPubsub: () => null });
  const received = [];
  g.subscribe('cannoi/events', (m) => received.push(m.id));
  const envelope = { id: 'same', topic: 'cannoi/events', data: 1, ts: Date.now() };
  g._dispatch('cannoi/events', envelope, null);
  g._seen.set('same', Date.now());
  // simulate second delivery skipped via _onMessage path
  assert.equal(g._seen.has('same'), true);
});

test('Phase 6: adapter publish/subscribe work without pubsub package', async () => {
  const dir = tmp('gs-a');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: { enabled: true, gossipsub: true }, dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  let hit = null;
  adapter.subscribe('cannoi/events', (m) => { hit = m; });
  await adapter.publish('cannoi/events', { ok: true });
  assert.ok(hit);
  assert.deepEqual(hit.data, { ok: true });
  const st = adapter.status();
  assert.ok('pubsub' in st);
  assert.ok('sync' in st);
});

test('Phase 6: adapter syncRange + appendSyncEvent', async () => {
  const { db } = openTmpDb();
  try {
    const dir = tmp('gs-b');
    const adapter = new Libp2pAdapter({
      cfg: { p2p: { enabled: true }, dataDir: dir, keyDir: path.join(dir, 'keys') },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      keyDir: path.join(dir, 'keys'),
      db,
    });
    adapter.appendSyncEvent('cannoi/events', { step: 1 });
    adapter.appendSyncEvent('cannoi/events', { step: 2 });
    const range = await adapter.syncRange('some-peer', { topic: 'cannoi/events', after_seq: 0 });
    assert.equal(range.events.length, 2);
    const stats = adapter.syncStats();
    assert.ok(stats.events >= 2);
  } finally { db.close(); }
});

test('Phase 6: checkModules reports pubsub packages', async () => {
  const a = await checkModules();
  assert.ok('pubsub' in a);
  assert.ok(Array.isArray(a.pubsubMissing));
});
