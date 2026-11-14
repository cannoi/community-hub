'use strict';
/**
 * Phase 8 — Compact NETWORK UI data contract tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Libp2pAdapter } = require('../src/net/p2p/libp2p-adapter');
const { tmp } = require('./helpers');

test('Phase 8: adapter status provides fields needed by NETWORK UI', () => {
  const dir = tmp('ui1');
  const adapter = new Libp2pAdapter({
    cfg: { p2p: { enabled: true }, dataDir: dir, keyDir: path.join(dir, 'keys') },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    keyDir: path.join(dir, 'keys'),
  });
  const st = adapter.status();
  // Fields consumed by /api/sync/status → UI
  assert.ok('network_state' in st || 'state' in st);
  assert.ok('preferred_transport' in st);
  assert.ok('peers' in st);
  assert.ok('lan_peers' in st);
  assert.ok('relay_connections' in st);
  assert.ok('pending_local_messages' in st);
  assert.ok('reachability' in st);
});

test('Phase 8: i18n contains EN and VI net.p2p keys', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8');
  const keys = [
    'net.p2p.title',
    'net.p2p.state.GLOBAL_ONLINE',
    'net.p2p.state.OFFLINE',
    'net.p2p.state.LAN_ONLY',
    'net.p2p.state.RELAY_ONLY',
    'net.p2p.state.RECOVERING',
    'net.p2p.transport.direct',
    'net.p2p.transport.store_and_forward',
    'net.p2p.peers',
    'net.p2p.queue',
  ];
  for (const k of keys) {
    const occurrences = src.split("'" + k + "'").length - 1;
    assert.ok(occurrences >= 2, k + ' should appear in EN and VI (got ' + occurrences + ')');
  }
});

test('Phase 8: views.js renders net-p2p-card from s.p2p', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/views.js'), 'utf8');
  assert.ok(src.includes('net-p2p-card'));
  assert.ok(src.includes('s.p2p'));
  assert.ok(src.includes('net.p2p.state.'));
  assert.ok(src.includes('preferred_transport'));
});

test('Phase 8: admin route enriches sync status with p2p', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/admin.js'), 'utf8');
  assert.ok(src.includes('hub.net'));
  assert.ok(src.includes('pending_messages'));
  assert.ok(src.includes('preferred_transport'));
  assert.ok(src.includes('network_state') || src.includes('net.network_state'));
});
