'use strict';
/**
 * Auto-Bootstrap & Self-Registering Peer Network tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const http = require('http');
const { openDatabase } = require('../src/db');
const { PeerDatabase } = require('../src/net/p2p/bootstrap/peer-db');
const { BootstrapManager, BOOTSTRAP_STATES } = require('../src/net/p2p/bootstrap/manager');
const {
  createFixedSeedProvider, createKnownPeerProvider, createHttpsManifestProvider,
  validateManifest, publishPeerRecord,
} = require('../src/net/p2p/bootstrap/providers');
const {
  createPeerRecord, signPeerRecord, verifyPeerRecord, PeerRegistry,
} = require('../src/net/p2p/bootstrap/peer-record');
const { Libp2pAdapter } = require('../src/net/p2p/libp2p-adapter');
const { loadConfig } = require('../src/config');
const { tmp, startHub, Client } = require('./helpers');

function openTmpDb() {
  const dir = tmp('bs');
  const db = openDatabase(path.join(dir, 't.db'), { info() {}, warn() {} });
  return { db, dir };
}

test('Bootstrap: public HTTP descriptor endpoint is available without login', async () => {
  const hub = await startHub({ publicUrl: 'http://14.176.78.46:28090' });
  try {
    const client = new Client(hub.base);
    const response = await client.get('/p2p/bootstrap');
    assert.equal(response.status, 200);
    assert.equal(response.json.network, 'cannoi');
    assert.equal(response.json.status, 'p2p-unavailable');
    assert.deepEqual(response.json.multiaddrs, []);
  } finally { await hub.stop(); }
});

test('Bootstrap: public registration endpoint validates and accepts a public peer hint', async () => {
  const hub = await startHub();
  try {
    let received = null;
    hub.net = { registerBootstrapPeer(record) { received = record; return { accepted: 1 }; } };
    const client = new Client(hub.base);
    const peerId = '12D3KooWregisterTest123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const record = { peer_id: peerId, network: 'cannoi', protocol: '1', registered_at: Date.now(), expires_at: Date.now() + 3600000,
      multiaddrs: [`/ip4/8.8.8.8/tcp/28090/ws/p2p/${peerId}`] };
    const response = await client.post('/p2p/register', { record });
    assert.equal(response.status, 200);
    assert.equal(response.json.accepted, 1);
    assert.equal(received.peer_id, peerId);
    const privateId = '12D3KooWprivateTest123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const rejected = await client.post('/p2p/register', { record: { ...record, peer_id: privateId,
      multiaddrs: [`/ip4/192.168.1.10/tcp/28090/ws/p2p/${privateId}`] } });
    assert.equal(rejected.status, 400);
  } finally { await hub.stop(); }
});

test('Bootstrap: migration 9 creates peer_db and registry tables', () => {
  const { db } = openTmpDb();
  try {
    assert.ok(db.hasTable('p2p_peer_db'));
    assert.ok(db.hasTable('p2p_peer_registry'));
    const ids = db.all('SELECT id FROM schema_migrations').map((r) => r.id);
    assert.ok(ids.includes(9));
  } finally { db.close(); }
});

test('Bootstrap: config includes fixedSeeds defaulting to public Hub IP', () => {
  const cfg = loadConfig({});
  assert.ok(Array.isArray(cfg.p2p.fixedSeeds));
  assert.ok(cfg.p2p.fixedSeeds.some((s) => String(s).includes('14.176.78.46:28090')));
});

test('Bootstrap: first install with empty peer DB → WAITING_FOR_FIRST_PEER', async () => {
  const { db } = openTmpDb();
  try {
    const mgr = new BootstrapManager({
      cfg: { fixedSeeds: [], bootstrap: [], httpsSeedManifests: [], dnsSeeds: [], bootstrapIntervalMs: 600000 },
      db,
      log: { debug() {}, info() {}, warn() {} },
      getPeerId: () => '12D3KooWlocal',
      getMultiaddrs: () => [],
      getLanPeers: () => [],
      getReachability: () => 'unknown',
      getConnectedPeerIds: () => [],
    });
    mgr.start();
    await mgr.runCycle();
    assert.equal(mgr.state(), BOOTSTRAP_STATES.WAITING_FOR_FIRST_PEER);
    assert.equal(mgr.status().cannoi_connected, 0);
    // Never claim NETWORK_JOINED without real peer
    assert.notEqual(mgr.state(), BOOTSTRAP_STATES.NETWORK_JOINED);
    mgr.stop();
  } finally { db.close(); }
});

test('Bootstrap: PeerDatabase persists and scores peers', () => {
  const { db } = openTmpDb();
  try {
    const pdb = new PeerDatabase({ db });
    pdb.upsert({ peerId: 'peerA', multiaddrs: ['/ip4/1.2.3.4/tcp/1/ws'], category: 'cannoi', source: 'fixed' });
    pdb.markSuccess('peerA');
    const got = pdb.get('peerA');
    assert.ok(got);
    assert.equal(got.category, 'cannoi');
    assert.ok(got.success_count >= 1);
    assert.ok(pdb.asCandidates().length >= 1);
  } finally { db.close(); }
});

test('Bootstrap: fixed seed provider returns HTTPS cannoi seed', async () => {
  const p = createFixedSeedProvider(['http://14.176.78.46']);
  assert.equal(p.isEnabled(), true);
  const list = await p.discover();
  assert.ok(list.length >= 1);
  assert.equal(list[0].category, 'cannoi');
  assert.ok(list[0].endpoint.includes('14.176.78.46'));
});

test('Bootstrap: HTTPS manifest validation rejects wrong network / expired', () => {
  assert.throws(() => validateManifest({ network: 'other', peers: [] }), /network/);
  assert.throws(() => validateManifest({ network: 'cannoi', expires_at: 1, peers: [] }), /expired/);
  const peers = validateManifest({
    version: 1, network: 'cannoi', expires_at: Date.now() + 60000,
    peers: [{ peer_id: 'p1', multiaddrs: ['/ip4/1.1.1.1/tcp/4001/ws'], category: 'cannoi' }],
  });
  assert.equal(peers.length, 1);
  assert.equal(peers[0].peerId, 'p1');
});

test('Bootstrap: HTTPS manifest provider fetches local seed server', async () => {
  const manifest = {
    version: 1, network: 'cannoi', expires_at: Date.now() + 60000,
    peers: [{ peer_id: '12D3KooWseedpeer', multiaddrs: ['/ip4/9.9.9.9/tcp/4001/ws'], category: 'cannoi' }],
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const p = createHttpsManifestProvider([`http://127.0.0.1:${port}/seed.json`]);
    const list = await p.discover();
    assert.equal(list.length, 1);
    assert.equal(list[0].peerId, '12D3KooWseedpeer');
  } finally {
    server.close();
  }
});

test('Bootstrap: peer record verify rejects expired', () => {
  const rec = createPeerRecord({ peerId: 'x', multiaddrs: ['/ip4/8.8.8.8/tcp/1/ws'], ttlMs: -1000 });
  const v = verifyPeerRecord(rec);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'expired');
});

test('Bootstrap: peer record does not include private LAN by default', () => {
  const rec = createPeerRecord({
    peerId: 'x',
    multiaddrs: ['/ip4/192.168.1.5/tcp/4001/ws', '/ip4/8.8.8.8/tcp/4001/ws'],
  });
  assert.ok(!rec.multiaddrs.some((a) => a.includes('192.168')));
  assert.ok(rec.multiaddrs.some((a) => a.includes('8.8.8.8')));
});

test('Bootstrap: registry put + list', () => {
  const { db } = openTmpDb();
  try {
    const reg = new PeerRegistry({ db });
    const rec = createPeerRecord({ peerId: 'reg1', multiaddrs: ['/ip4/1.2.3.4/tcp/1/ws'] });
    assert.equal(reg.put(rec).ok, true);
    assert.ok(reg.get('reg1'));
    assert.ok(reg.list().length >= 1);
  } finally { db.close(); }
});

test('Bootstrap: NETWORK_JOINED only after connected cannoi peer', async () => {
  const { db } = openTmpDb();
  try {
    const connected = ['12D3KooWcannoi1'];
    const mgr = new BootstrapManager({
      cfg: { fixedSeeds: [], bootstrapIntervalMs: 600000 },
      db,
      log: { debug() {}, info() {}, warn() {} },
      getPeerId: () => 'me',
      getConnectedPeerIds: () => connected,
      getReachability: () => 'public',
      getMultiaddrs: () => ['/ip4/1.2.3.4/tcp/4001/ws'],
    });
    // Seed peer db so category is cannoi
    mgr.peerDb.upsert({ peerId: '12D3KooWcannoi1', multiaddrs: [], category: 'cannoi', source: 'fixed' });
    mgr.start();
    await mgr.runCycle();
    assert.equal(mgr.state(), BOOTSTRAP_STATES.NETWORK_JOINED);
    mgr.stop();
  } finally { db.close(); }
});

test('Bootstrap: acceptExchange rejects malformed / accepts valid', () => {
  const mgr = new BootstrapManager({ cfg: {}, log: { debug() {}, info() {}, warn() {} } });
  const bad = mgr.acceptExchange([{ peer_id: null }]);
  assert.equal(bad.accepted, 0);
  const rec = createPeerRecord({ peerId: 'ex1', multiaddrs: ['/ip4/5.5.5.5/tcp/1/ws'] });
  const ok = mgr.acceptExchange([rec]);
  assert.equal(ok.accepted, 1);
});

test('Bootstrap: HTTP seed resolves a live Peer ID and dialable multiaddr', async () => {
  const peerId = '12D3KooWbootstrapTest123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/p2p/bootstrap');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ network: 'cannoi', protocol: '1', peer_id: peerId, multiaddrs: [`/ip4/14.176.78.46/tcp/28090/ws/p2p/${peerId}`] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = createFixedSeedProvider([`http://127.0.0.1:${server.address().port}`]);
    const found = await provider.discover();
    assert.equal(found.length, 1);
    assert.equal(found[0].peerId, peerId);
    assert.ok(found[0].multiaddrs[0].endsWith('/p2p/' + peerId));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('Bootstrap: peer self-registration posts a bounded record to the seed', async () => {
  const record = { peer_id: '12D3KooWregister', network: 'cannoi', multiaddrs: ['/ip4/8.8.8.8/tcp/28090/ws/p2p/12D3KooWregister'] };
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/p2p/register');
    let body = '';
    req.setEncoding('utf8'); req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { const parsed = JSON.parse(body); assert.equal(parsed.record.peer_id, record.peer_id); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true,"accepted":1}'); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await publishPeerRecord(`http://127.0.0.1:${server.address().port}`, record);
    assert.equal(result.accepted, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('Bootstrap: HTTP seed imports the rendezvous peer list', async () => {
  const peerId = '12D3KooWpeerTwo123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ network: 'cannoi', peer_id: '12D3KooWseed123456789ABCDEFGHJKLMNPQRSTUVWXYZ', multiaddrs: ['/ip4/14.176.78.46/tcp/28090/ws/p2p/12D3KooWseed123456789ABCDEFGHJKLMNPQRSTUVWXYZ'], peers: [
      { network: 'cannoi', peer_id: peerId, multiaddrs: [`/ip4/8.8.8.8/tcp/28090/ws/p2p/${peerId}`] },
    ] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const found = await createFixedSeedProvider([`http://127.0.0.1:${server.address().port}`]).discover();
    assert.ok(found.some((peer) => peer.peerId === peerId));
    assert.ok(found.some((peer) => peer.peerId === '12D3KooWseed123456789ABCDEFGHJKLMNPQRSTUVWXYZ'));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('Bootstrap: advertised address uses public gateway, never loopback listener', () => {
  const adapter = new Libp2pAdapter({
    cfg: { publicUrl: 'http://14.176.78.46:28090', p2p: { wsGateway: true } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  adapter._node = {};
  adapter._peerId = '12D3KooWlocal';
  const info = adapter.bootstrapInfo();
  assert.deepEqual(info.multiaddrs, ['/ip4/14.176.78.46/tcp/28090/ws/p2p/12D3KooWlocal']);
  assert.ok(!info.multiaddrs.some((addr) => addr.includes('127.0.0.1')));
});

test('Bootstrap: HTTP seed rejects a descriptor for another network', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ network: 'other', peer_id: 'peer', multiaddrs: ['/ip4/1.2.3.4/tcp/1/ws/p2p/peer'] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = createFixedSeedProvider([`http://127.0.0.1:${server.address().port}`]);
    const found = await provider.discover();
    assert.equal(found.length, 1);
    assert.equal(found[0].peerId, 'https:127.0.0.1:' + server.address().port);
    assert.deepEqual(found[0].multiaddrs, []);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('Bootstrap: adapter exposes bootstrap status', async () => {
  const dir = tmp('bs-ad');
  const db = openDatabase(path.join(dir, 't.db'), { info() {}, warn() {} });
  try {
    const adapter = new Libp2pAdapter({
      cfg: { p2p: { enabled: true, fixedSeeds: ['http://14.176.78.46'], bootstrapIntervalMs: 600000 }, dataDir: dir, keyDir: path.join(dir, 'keys') },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      keyDir: path.join(dir, 'keys'),
      db,
    });
    await adapter.start();
    await new Promise((r) => setTimeout(r, 100));
    const st = adapter.status();
    assert.ok(st.bootstrap);
    assert.ok(st.bootstrap.state);
    assert.ok(Array.isArray(st.bootstrap.providers));
    // Honest: not NETWORK_JOINED without peers
    assert.notEqual(adapter.bootstrapState(), BOOTSTRAP_STATES.NETWORK_JOINED);
    await adapter.stop();
  } finally { db.close(); }
});

test('Bootstrap: provider failover — known peers work when fixed empty', async () => {
  const { db } = openTmpDb();
  try {
    const pdb = new PeerDatabase({ db });
    pdb.upsert({
      peerId: 'cached1',
      multiaddrs: ['/ip4/7.7.7.7/tcp/4001/ws/p2p/cached1'],
      category: 'cannoi',
      source: 'known',
    });
    const known = createKnownPeerProvider(pdb);
    const list = await known.discover();
    assert.ok(list.some((c) => c.peerId === 'cached1'));
  } finally { db.close(); }
});
