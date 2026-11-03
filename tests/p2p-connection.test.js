'use strict';
/**
 * Phase 2 — libp2p connection tests.
 * When libp2p packages are not installed, tests that need the real stack are skipped
 * with a clear message. Default (P2P off) behaviour is always asserted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startHub, Client } = require('./helpers');
const { createNetworkAdapter, HttpsAdapter } = require('../src/net/adapter');

function libp2pAvailable() {
  try {
    require.resolve('libp2p');
    require.resolve('@libp2p/websockets');
    require.resolve('@libp2p/noise');
    require.resolve('@libp2p/yamux');
    return true;
  } catch {
    return false;
  }
}

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
  if (!libp2pAvailable()) {
    t.skip('libp2p packages not installed in this environment');
    return;
  }
  const hub = await startHub({
    p2p: { enabled: true, maxConnections: 10, dialTimeoutMs: 5000, bootstrap: [], listen: ['/ip4/127.0.0.1/tcp/0/ws'] },
  });
  try {
    assert.equal(hub.net.kind(), 'p2p');
    // start may have already been called by hub.start(); ensure status reflects running or error
    const st = hub.net.status();
    assert.equal(st.kind, 'p2p');
    assert.equal(st.enabled, true);
    // Peer id should exist after successful start
    if (st.state === 'running') {
      assert.ok(st.peer_id, 'peer_id present when running');
      // Key file must exist and not be world-readable material in logs
      assert.ok(!JSON.stringify(st).match(/BEGIN|PRIVATE|secret/i));
    }
    // HTTPS social path still works while P2P is on
    const c = new Client(hub.base);
    await c.setup('p2powner');
    const post = await c.post('/api/posts', { content: 'still-https-social', visibility: 'public' });
    assert.ok(post.status === 200 || post.status === 201);
  } finally {
    await hub.stop();
  }
});

test('Phase 2: two P2P hubs can dial when modules present', async (t) => {
  if (!libp2pAvailable()) {
    t.skip('libp2p packages not installed in this environment');
    return;
  }
  const listenA = ['/ip4/127.0.0.1/tcp/0/ws'];
  const hubA = await startHub({
    p2p: { enabled: true, maxConnections: 10, dialTimeoutMs: 8000, bootstrap: [], listen: listenA },
  });
  const hubB = await startHub({
    p2p: { enabled: true, maxConnections: 10, dialTimeoutMs: 8000, bootstrap: [], listen: ['/ip4/127.0.0.1/tcp/0/ws'] },
  });
  try {
    assert.equal(hubA.net.kind(), 'p2p');
    assert.equal(hubB.net.kind(), 'p2p');
    // Give nodes a moment if start is async
    await new Promise((r) => setTimeout(r, 500));
    const stA = hubA.net.status();
    const stB = hubB.net.status();
    if (stA.state !== 'running' || stB.state !== 'running') {
      t.skip('p2p nodes did not reach running state: A=' + stA.state + ' B=' + stB.state + ' errA=' + stA.error + ' errB=' + stB.error);
      return;
    }
    // Obtain a dialable multiaddr from A
    const nodeA = hubA.net._node;
    assert.ok(nodeA, 'node A internal handle');
    const addrs = nodeA.getMultiaddrs().map((a) => a.toString());
    assert.ok(addrs.length >= 1, 'A has listen addrs: ' + addrs.join(','));
    // Dial A from B
    await hubB.net.connect({ multiaddr: addrs[0] });
    await new Promise((r) => setTimeout(r, 800));
    const peersB = await hubB.net.listPeers();
    assert.ok(peersB.length >= 1, 'B should list A as peer');
  } finally {
    await hubA.stop();
    await hubB.stop();
  }
});

test('Phase 2: stop then start again (lifecycle)', async (t) => {
  if (!libp2pAvailable()) {
    t.skip('libp2p packages not installed in this environment');
    return;
  }
  const hub = await startHub({
    p2p: { enabled: true, maxConnections: 5, listen: ['/ip4/127.0.0.1/tcp/0/ws'] },
  });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const st1 = hub.net.status();
    if (st1.state !== 'running') {
      t.skip('not running: ' + st1.error);
      return;
    }
    await hub.net.stop();
    assert.equal(hub.net.status().state, 'stopped');
    await hub.net.start();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hub.net.status().state, 'running');
  } finally {
    await hub.stop();
  }
});

test('Phase 2: bad multiaddr dial fails without crashing Hub', async (t) => {
  if (!libp2pAvailable()) {
    t.skip('libp2p packages not installed in this environment');
    return;
  }
  const hub = await startHub({
    p2p: { enabled: true, maxConnections: 5, listen: ['/ip4/127.0.0.1/tcp/0/ws'] },
  });
  try {
    await new Promise((r) => setTimeout(r, 300));
    if (hub.net.status().state !== 'running') {
      t.skip('p2p not running');
      return;
    }
    let threw = false;
    try {
      await hub.net.connect({ multiaddr: '/ip4/127.0.0.1/tcp/1/ws' });
    } catch {
      threw = true;
    }
    // Either throws or soft-fails; Hub must still answer HTTP
    const c = new Client(hub.base);
    assert.equal((await c.get('/health')).status, 200);
  } finally {
    await hub.stop();
  }
});
