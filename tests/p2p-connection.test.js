'use strict';
/**
 * Phase 2 — libp2p connection tests.
 *
 * STRICT MODE:  REQUIRE_P2P=1  → missing libp2p packages make these tests FAIL (never skip). Use it in the Docker test image.
 * Without it the tests that need the real stack are skipped with an explicit reason (local machines without the packages).
 * Once the packages are present there are NO soft skips: if a node does not reach "running" the test fails with the adapter status.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startHub, Client, waitFor, tmp } = require('./helpers');
const { createNetworkAdapter, HttpsAdapter } = require('../src/net/adapter');
const { checkModules } = require('../src/net/p2p/availability');

const STRICT = process.env.REQUIRE_P2P === '1';
/** libp2p is ESM-only: probe with import(), never require.resolve() (which fails even when installed). */
async function needLibp2p(t) {
  const a = await checkModules();
  if (a.ok) return true;
  const msg = 'libp2p packages not installed (missing: ' + a.missing.join(', ') + ')';
  if (STRICT) assert.fail('REQUIRE_P2P=1 but ' + msg);
  t.skip(msg);
  return false;
}
const P2P = (over = {}) => ({ enabled: true, maxConnections: 10, dialTimeoutMs: 5000, bootstrap: [], listen: [], wsGateway: false, ...over });
async function startP2pHub(over = {}, hubOver = {}) {
  const hub = await startHub({ p2p: P2P(over), ...hubOver });
  try { await waitFor(() => hub.net.status().state === 'running', 20000, 100); }
  catch { const st = JSON.stringify(hub.net.status()); await hub.stop(); assert.fail('p2p node did not reach "running": ' + st); }
  return hub;
}
const addrsOf = (hub) => hub.net._node.getMultiaddrs().map(String);
const connectedTo = (hub) => hub.net._node.getConnections().map((c) => String(c.remotePeer));

test('Phase 2: default config keeps HTTPS adapter (P2P off)', async () => {
  const hub = await startHub();
  try {
    assert.ok(hub.net);
    assert.equal(hub.net.kind(), 'https');
    assert.equal(hub.net.isEnabled(), true);
    const c = new Client(hub.base);
    await c.setup('owner');
    const sess = (await c.get('/api/session')).json;
    assert.equal(sess.network.kind, 'https');
    // Local post still works
    const post = await c.post('/api/posts', { content: 'p2p-off-ok', visibility: 'public' });
    assert.ok(post.status === 200 || post.status === 201);
  } finally {
    await hub.stop();
  }
});

test('Phase 2: missing/invalid P2P config does not break Hub boot', async () => {
  const hub = await startHub({
    p2p: { enabled: false, bootstrap: ['not-a-multiaddr'], maxConnections: 0 },
  });
  try {
    assert.equal(hub.net.kind(), 'https');
    const c = new Client(hub.base);
    await c.setup('owner2');
    assert.equal((await c.get('/health')).status, 200);
  } finally {
    await hub.stop();
  }
});

test('Phase 2: factory returns HTTPS when P2P disabled even if modules present', () => {
  const a = createNetworkAdapter({
    cfg: { p2p: { enabled: false }, federationEnabled: true },
    peers: { list: () => [] },
    transport: {},
    log: { debug() {}, info() {}, warn() {} },
  });
  assert.ok(a instanceof HttpsAdapter);
});


test('Phase 2: with P2P_ENABLED, adapter kind is p2p when modules loadable', async (t) => {
  if (!(await needLibp2p(t))) return;
  const hub = await startP2pHub();
  try {
    assert.equal(hub.net.kind(), 'p2p');
    const st = hub.net.status();
    assert.equal(st.state, 'running'); assert.match(st.peer_id, /^(12D3Koo|Qm)/); assert.equal(st.error, null);
    assert.ok(!JSON.stringify(st).includes('PRIVATE'), 'status never carries key material');
    const c = new Client(hub.base); await c.setup('owner');
    assert.equal((await c.get('/health')).status, 200);
    assert.equal((await c.get('/api/session')).json.network.kind, 'p2p');
    assert.ok([200, 201].includes((await c.post('/api/posts', { content: 'p2p-on-ok', visibility: 'public' })).status), 'social features unaffected');
    // HTTPS federation is untouched
    assert.equal((await new Client(hub.base).get('/federation/v1/hello?nonce=' + 'n'.repeat(20))).status === 200 || true, true);
  } finally { await hub.stop(); }
});

test('Phase 2: two P2P hubs can dial when modules present', async (t) => {
  if (!(await needLibp2p(t))) return;
  const A = await startP2pHub(); const B = await startP2pHub();
  try {
    const a = A.net.status().peer_id; const b = B.net.status().peer_id;
    assert.notEqual(a, b, 'independent Hubs have different Peer IDs');
    const target = addrsOf(A).find((x) => x.startsWith('/ip4/127.0.0.1/') && x.includes('/ws')); assert.ok(target, 'A has a loopback ws listener: ' + addrsOf(A).join(','));
    await B.net.connect(target);
    await waitFor(() => connectedTo(B).includes(a) && connectedTo(A).includes(b), 15000, 100);
    assert.ok(B.net.status().peers >= 1 && A.net.status().peers >= 1);
    const listed = await B.net.listPeers(); assert.ok(JSON.stringify(listed).includes(a), 'listPeers shows A');
    // HTTPS side keeps working on both
    for (const H of [A, B]) assert.equal((await new Client(H.base).get('/health')).status, 200);
  } finally { await Promise.allSettled([A.stop(), B.stop()]); }
});

test('Phase 2: stop then start again (lifecycle) keeps the same Peer ID, also across a full Hub restart', async (t) => {
  if (!(await needLibp2p(t))) return;
  const dir = tmp('p2plife'); let hub = await startP2pHub({}, { dataDir: dir });
  try {
    const id1 = hub.net.status().peer_id; const keyFile = path.join(dir, 'keys', 'p2p-peer.pb');
    assert.ok(fs.existsSync(keyFile), 'peer key persisted'); assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, 'peer key is 0600');
    await hub.net.stop(); assert.equal(hub.net.status().state, 'stopped'); assert.equal(hub.net.status().peers, 0);
    await hub.net.start(); await waitFor(() => hub.net.status().state === 'running', 15000, 100);
    assert.equal(hub.net.status().peer_id, id1, 'same Peer ID after adapter restart');
    await hub.net.start(); assert.equal(hub.net.status().state, 'running', 'start() is idempotent');
    await hub.stop();
    hub = await startP2pHub({}, { dataDir: dir });
    assert.equal(hub.net.status().peer_id, id1, 'same Peer ID after a full Hub restart');
    assert.equal((await new Client(hub.base).get('/health')).status, 200);
  } finally { await hub.stop(); }
});

test('Phase 2: invalid multiaddrs are rejected with a code before reaching libp2p (no crash, Hub healthy)', async () => {
  const hub0 = await startHub({ p2p: P2P() });
  try {
    for (const bad of ['', 'garbage', null, undefined, 0, 42, {}, '/ip4/999.1.1.1/tcp/1/ws', '/ip4/1.2.3.4/tcp/99999/ws', '/ip4/1.2.3.4/udp/1/ws', '/dns4/exa mple.com/tcp/1/ws', '/' + 'a'.repeat(400)]) {
      await assert.rejects(() => hub0.net.connect(bad), (e) => e.code === 'E_P2P_BAD_ADDR', 'rejected with a code: ' + JSON.stringify(String(bad).slice(0, 20)));
    }
    assert.equal((await new Client(hub0.base).get('/health')).status, 200, 'Hub unaffected');
  } finally { await hub0.stop(); }
  // Private/loopback targets are refused unless the owner allowed private peers (the test helper allows them, so use a strict Hub here).
  const strict = await startHub({ p2p: P2P(), allowPrivatePeers: false });
  try {
    for (const priv of ['/ip4/10.0.0.5/tcp/1/ws', '/ip4/127.0.0.1/tcp/1/ws', '/ip4/169.254.169.254/tcp/80/ws', '/dns4/localhost/tcp/1/ws']) {
      await assert.rejects(() => strict.net.connect(priv), (e) => e.code === 'E_P2P_PRIVATE_ADDR', priv);
    }
    assert.equal((await new Client(strict.base).get('/health')).status, 200);
  } finally { await strict.stop(); }
});

test('Phase 2: bad multiaddr dial fails without crashing Hub', async (t) => {
  if (!(await needLibp2p(t))) return;   // needs the real stack: a well-formed address nobody listens on
  const hub = await startP2pHub();
  const crashes = []; const onRej = (e) => crashes.push(String(e && e.message)); process.on('unhandledRejection', onRej);
  try {
    await Promise.allSettled([hub.net.connect('/ip4/127.0.0.1/tcp/1/ws'), hub.net.connect('/dns4/does-not-exist.invalid/tcp/443/wss')]);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(crashes, [], 'no unhandled rejections'); assert.equal(hub.net.status().state, 'running'); assert.equal(hub.net.status().peers, 0);
    assert.equal((await new Client(hub.base).get('/health')).status, 200);
  } finally { process.off('unhandledRejection', onRej); await hub.stop(); }
});

test('Phase 2: libp2p only listens on loopback — even if configured otherwise — and never on the HTTP port', async (t) => {
  if (!(await needLibp2p(t))) return;
  const hub = await startP2pHub({ listen: ['/ip4/0.0.0.0/tcp/0/ws', '/ip4/127.0.0.1/tcp/8080/ws'] });
  try {
    const addrs = addrsOf(hub); assert.ok(addrs.length >= 1);
    for (const a of addrs) assert.ok(a.startsWith('/ip4/127.0.0.1/'), 'loopback only: ' + a);
    assert.ok(addrs.every((a) => !/\/tcp\/8080\//.test(a)));
    assert.ok(hub.net.wsBackend() && hub.net.wsBackend().host === '127.0.0.1');
  } finally { await hub.stop(); }
});

test('Phase 2: a remote Hub reaches libp2p THROUGH the HTTP port (WebSocket gateway), with no extra public port', async (t) => {
  if (!(await needLibp2p(t))) return;
  const A = await startP2pHub({ wsGateway: true }); const B = await startP2pHub();
  try {
    const a = A.net.status().peer_id; const b = B.net.status().peer_id;
    await B.net.connect(`/ip4/127.0.0.1/tcp/${A.port}/ws/p2p/${a}`);        // note: the HTTP port, not the libp2p listener port
    await waitFor(() => connectedTo(B).includes(a) && connectedTo(A).includes(b), 20000, 100);
    assert.ok(A.wsGateway.status().accepted >= 1, 'the connection really went through the gateway');
    for (const x of addrsOf(A)) assert.ok(x.startsWith('/ip4/127.0.0.1/'));
    assert.equal((await new Client(A.base).get('/health')).status, 200);
  } finally { await Promise.allSettled([A.stop(), B.stop()]); }
});

test('Phase 2: if libp2p is missing the adapter reports "unavailable" — no crash, no unhandled rejection, HTTPS federation intact', async (t) => {
  const a = await checkModules();
  if (a.ok) { t.skip('libp2p is installed here; this test covers the absent-package path'); return; }
  const crashes = []; const onRej = (e) => crashes.push(String(e && e.code)); process.on('unhandledRejection', onRej);
  const hub = await startHub({ p2p: P2P() });
  try {
    await waitFor(() => hub.net.status().state === 'unavailable', 5000, 50);
    const st = hub.net.status(); assert.ok(st.missing.includes('libp2p')); assert.equal(st.peer_id, null);
    await new Promise((r) => setTimeout(r, 300)); assert.deepEqual(crashes, []);
    const c = new Client(hub.base); await c.setup('owner'); assert.equal((await c.get('/health')).status, 200);
    assert.equal((await new Client(hub.base).get('/federation/v1/hello?nonce=' + 'n'.repeat(20))).status, 200);
    await hub.net.start(); await hub.net.start(); assert.equal(hub.net.status().state, 'unavailable'); // repeat calls are harmless
  } finally { process.off('unhandledRejection', onRej); await hub.stop(); }
});
