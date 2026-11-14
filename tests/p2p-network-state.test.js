'use strict';
/**
 * Phase 7 — Network state manager and transport failover tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { NetworkStateManager, STATES, RANK } = require('../src/net/p2p/network-state');
const { Libp2pAdapter } = require('../src/net/p2p/libp2p-adapter');
const { loadConfig } = require('../src/config');
const { tmp } = require('./helpers');

function sig(over = {}) {
  return {
    peers: 0, directPeers: 0, relayPeers: 0, lanPeers: 0, knownRelays: 0,
    reachability: 'unknown', nodeRunning: true, pendingMessages: 0,
    mdnsEnabled: false, discoveryEnabled: false,
    ...over,
  };
}

test('Phase 7: STATES and RANK are consistent', () => {
  assert.ok(RANK[STATES.GLOBAL_ONLINE] > RANK[STATES.GLOBAL_DEGRADED]);
  assert.ok(RANK[STATES.LAN_ONLY] > RANK[STATES.RELAY_ONLY]);
  assert.ok(RANK[STATES.RELAY_ONLY] > RANK[STATES.OFFLINE]);
});

test('Phase 7: classifies GLOBAL_ONLINE when public + direct', () => {
  const m = new NetworkStateManager({ dwellMs: 1, recoverMs: 1 });
  // leave OFFLINE via RECOVERING
  m.evaluate(sig({ peers: 1, directPeers: 1, reachability: 'public' }));
  assert.equal(m.state(), STATES.RECOVERING);
  m._enteredAt = Date.now() - 10;
  m.evaluate(sig({ peers: 1, directPeers: 1, reachability: 'public' }));
  assert.equal(m.state(), STATES.GLOBAL_ONLINE);
  assert.equal(m.preferredTransport(), 'direct');
});

test('Phase 7: classifies RELAY_ONLY when only relayed', () => {
  const m = new NetworkStateManager({ dwellMs: 1, recoverMs: 1 });
  m.evaluate(sig({ peers: 2, relayPeers: 2, directPeers: 0, reachability: 'private' }));
  assert.equal(m.state(), STATES.RECOVERING);
  m._enteredAt = Date.now() - 10;
  m.evaluate(sig({ peers: 2, relayPeers: 2, directPeers: 0, reachability: 'private' }));
  assert.equal(m.state(), STATES.RELAY_ONLY);
  assert.equal(m.preferredTransport(), 'relay');
});

test('Phase 7: classifies LAN_ONLY for local peers', () => {
  const m = new NetworkStateManager({ dwellMs: 1, recoverMs: 1 });
  m.evaluate(sig({ peers: 1, directPeers: 1, lanPeers: 2, reachability: 'private', mdnsEnabled: true }));
  m._enteredAt = Date.now() - 10;
  m.evaluate(sig({ peers: 1, directPeers: 1, lanPeers: 2, reachability: 'private', mdnsEnabled: true }));
  assert.equal(m.state(), STATES.LAN_ONLY);
  assert.equal(m.preferredTransport(), 'lan');
});

test('Phase 7: OFFLINE when node not running', () => {
  const m = new NetworkStateManager();
  m.evaluate(sig({ nodeRunning: false, peers: 5 }));
  assert.equal(m.state(), STATES.OFFLINE);
  assert.equal(m.preferredTransport(), 'store_and_forward');
});

test('Phase 7: anti-flapping — downward blocked during dwell', () => {
  const m = new NetworkStateManager({ dwellMs: 60000, recoverMs: 1 });
  // go up
  m.evaluate(sig({ peers: 1, directPeers: 1, reachability: 'public' }));
  m._enteredAt = Date.now() - 10;
  m.evaluate(sig({ peers: 1, directPeers: 1, reachability: 'public' }));
  assert.equal(m.state(), STATES.GLOBAL_ONLINE);
  // try go down immediately — should stay
  const r = m.evaluate(sig({ peers: 0, directPeers: 0, reachability: 'unknown' }));
  assert.equal(r.changed, false);
  assert.equal(m.state(), STATES.GLOBAL_ONLINE);
});

test('Phase 7: upward from OFFLINE goes through RECOVERING', () => {
  const m = new NetworkStateManager({ dwellMs: 1, recoverMs: 60000 });
  assert.equal(m.state(), STATES.OFFLINE);
  const r = m.evaluate(sig({ peers: 1, directPeers: 1, reachability: 'public' }));
  assert.equal(r.changed, true);
  assert.equal(m.state(), STATES.RECOVERING);
});

test('Phase 7: history records transitions', () => {
  const m = new NetworkStateManager({ dwellMs: 1, recoverMs: 1 });
  m.evaluate(sig({ peers: 1, relayPeers: 1 }));
  m._enteredAt = Date.now() - 10;
  m.evaluate(sig({ peers: 1, relayPeers: 1 }));
  assert.ok(m.history().length >= 1);
  const snap = m.snapshot();
  assert.ok(snap.state);
  assert.ok(snap.preferred_transport);
});

test('Phase 7: config exposes state dwell/recover', () => {
  const cfg = loadConfig({ P2P_STATE_DWELL_MS: '12000', P2P_STATE_RECOVER_MS: '3000' });
  assert.equal(cfg.p2p.stateDwellMs, 12000);
  assert.equal(cfg.p2p.stateRecoverMs, 3000);
});

test('Phase 7: adapter status includes network_state and preferred_transport', () => {
  const dir = tmp('ns1');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: { enabled: true }, dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  const st = adapter.status();
  assert.ok('network_state' in st);
  assert.ok('preferred_transport' in st);
  assert.equal(st.network_state, 'OFFLINE');
  assert.equal(adapter.preferredTransport(), 'store_and_forward');
  const snap = adapter.networkState();
  assert.equal(snap.state, 'OFFLINE');
});

test('Phase 7: onTransition flushes is registered (smoke)', () => {
  const dir = tmp('ns2');
  let flushed = false;
  const adapter = new Libp2pAdapter({
    cfg: { p2p: { enabled: true, stateDwellMs: 1, stateRecoverMs: 1 }, dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  // Replace messaging flush to observe
  adapter._localMessaging.flush = async () => { flushed = true; return { sent: 0, remaining: 0 }; };
  // Manually drive state upward
  adapter._netState.evaluate(sig({ peers: 1, directPeers: 1, reachability: 'public' }));
  // onTransition from OFFLINE → RECOVERING should attempt flush
  assert.equal(adapter._netState.state(), STATES.RECOVERING);
  assert.equal(flushed, true);
});
