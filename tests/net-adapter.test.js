'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startHub, Client } = require('./helpers');
const { createNetworkAdapter, HttpsAdapter, NullAdapter } = require('../src/net/adapter');

test('Phase 1: HTTPS adapter is default and does not change app behaviour', async () => {
  const hub = await startHub();
  try {
    assert.ok(hub.net, 'hub.net exists');
    assert.equal(hub.net.kind(), 'https');
    assert.equal(hub.net.isEnabled(), true);
    const st = hub.net.status();
    assert.equal(st.kind, 'https');
    assert.equal(st.enabled, true);

    const c = new Client(hub.base);
    await c.setup('owner');
    const sess = (await c.get('/api/session')).json;
    assert.ok(sess.network);
    assert.equal(sess.network.kind, 'https');

    // Local social still works
    const post = await c.post('/api/posts', { content: 'adapter phase1', visibility: 'public' });
    assert.ok(post.status === 200 || post.status === 201, post.text);
  } finally {
    await hub.stop();
  }
});

test('Phase 1: factory returns HTTPS when P2P not enabled', () => {
  const fake = {
    cfg: { p2p: { enabled: false }, federationEnabled: true },
    peers: { list: () => [] },
    transport: {},
    log: { debug() {}, info() {}, warn() {} },
  };
  const a = createNetworkAdapter(fake);
  assert.ok(a instanceof HttpsAdapter);
  assert.equal(a.kind(), 'https');
});

test('Phase 1: NullAdapter when both federation and p2p disabled', () => {
  const fake = {
    cfg: { p2p: { enabled: false }, federationEnabled: false },
    peers: {},
    transport: {},
    log: {},
  };
  const a = createNetworkAdapter(fake);
  assert.ok(a instanceof NullAdapter);
  assert.equal(a.isEnabled(), false);
});
