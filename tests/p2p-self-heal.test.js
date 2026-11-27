'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SelfHealEngine, PEER_LIFECYCLE, jitter } = require('../src/net/p2p/self-heal');
const { NetworkStateManager, STATES } = require('../src/net/p2p/network-state');

describe('Phase 2 self-heal', () => {
  it('jitter stays near base', () => {
    const j = jitter(10000);
    assert.ok(j >= 7000 && j <= 13000);
  });

  it('tracks dial failures and escalates relay request', async () => {
    let relay = 0;
    let reconn = 0;
    const eng = new SelfHealEngine({
      requestRelayPass: async () => { relay++; },
      requestReconnect: async () => { reconn++; },
    });
    eng.noteDialResult('peerA', false);
    eng.noteDialResult('peerA', false);
    eng.noteDialResult('peerA', false);
    await eng.tick();
    assert.ok(relay >= 1);
    assert.ok(reconn >= 1);
    const st = eng.status();
    assert.equal(st.self_heal, true);
    assert.ok(st.fail_streak >= 3);
  });

  it('detects public IP change', async () => {
    let changed = null;
    let calls = 0;
    const eng = new SelfHealEngine({
      getPublicIp: async () => {
        calls++;
        return calls === 1 ? '1.1.1.1' : '2.2.2.2';
      },
      onIpChanged: async (a, b) => { changed = [a, b]; },
    });
    await eng.tick();
    await eng.tick();
    assert.deepEqual(changed, ['1.1.1.1', '2.2.2.2']);
    assert.equal(eng.status().stats.ip_changes, 1);
  });

  it('network state forcePreferRelay soft-degrades', () => {
    const ns = new NetworkStateManager({});
    ns.force(STATES.GLOBAL_ONLINE);
    ns.forcePreferRelay();
    assert.equal(ns.state(), STATES.GLOBAL_DEGRADED);
  });

  it('peer lifecycle constants exist', () => {
    assert.equal(PEER_LIFECYCLE.CONNECTED, 'connected');
    assert.equal(PEER_LIFECYCLE.OFFLINE, 'offline');
  });
});
