'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSeed } = require('../src/presence/seed-server');
const { createPeerRecord } = require('../src/net/p2p/bootstrap/peer-record');
const { createFixedSeedProvider, publishPeerRecord } = require('../src/net/p2p/bootstrap/providers');

const peerId = '12D3KooWregisterTest123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const logger = { debug() {}, info() {}, warn() {}, error() {} };

async function startSeed(dbFile) {
  const seed = createSeed({ PORT: '0', HOST: '127.0.0.1', PRESENCE_DB: dbFile }, { logger });
  await seed.start();
  seed.base = `http://127.0.0.1:${seed.port}`;
  return seed;
}

test('standalone seed exposes a directory descriptor without inventing its own P2P identity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-seed-p2p-'));
  const seed = await startSeed(path.join(dir, 'seed.db'));
  try {
    const res = await fetch(seed.base + '/p2p/bootstrap');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.network, 'cannoi');
    assert.equal(body.status, 'directory');
    assert.equal(body.role, 'rendezvous-seed');
    assert.equal(body.peer_id, null);
    assert.deepEqual(body.multiaddrs, []);
    assert.deepEqual(body.peers, []);
  } finally { await seed.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('standalone seed accepts VERIFIED public peer records and returns them to fixed-seed discovery', async () => {
  const probe = require('../src/net/p2p/bootstrap/probe'); const realProbe = probe.probePeerRecord; probe.probePeerRecord = async () => ({ verified: true });   // stands in for the probe-back to a real peer
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-seed-p2p-'));
  const dbFile = path.join(dir, 'seed.db');
  let seed = await startSeed(dbFile);
  try {
    const record = createPeerRecord({ peerId, multiaddrs: [`/ip4/8.8.8.8/tcp/28090/ws/p2p/${peerId}`] });
    const published = await publishPeerRecord(seed.base, record);
    assert.equal(published.accepted, 1);
    const response = await (await fetch(seed.base + '/p2p/bootstrap')).json();
    assert.equal(response.count, 1);
    assert.equal(response.peers[0].peer_id, peerId);
    const provider = createFixedSeedProvider([seed.base]);
    const found = await provider.discover();
    assert.equal(found.length, 1);
    assert.equal(found[0].peerId, peerId);
    assert.equal(found[0].multiaddrs[0], record.multiaddrs[0]);
  } finally { await seed.stop(); }

  // Registry entries survive a seed process restart.
  seed = await startSeed(dbFile);
  try {
    const response = await (await fetch(seed.base + '/p2p/bootstrap')).json();
    assert.equal(response.count, 1);
    assert.equal(response.peers[0].peer_id, peerId);
  } finally { probe.probePeerRecord = realProbe; await seed.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('standalone seed rejects private, malformed and expired P2P records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-seed-p2p-'));
  const seed = await startSeed(path.join(dir, 'seed.db'));
  try {
    const privateRecord = createPeerRecord({ peerId, multiaddrs: [`/ip4/192.168.1.20/tcp/28090/ws/p2p/${peerId}`], privateLanOk: true });
    let r = await fetch(seed.base + '/p2p/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ record: privateRecord }) });
    assert.equal(r.status, 400);
    const expired = { ...createPeerRecord({ peerId, multiaddrs: [`/ip4/8.8.8.8/tcp/28090/ws/p2p/${peerId}`] }), expires_at: Date.now() - 1 };
    r = await fetch(seed.base + '/p2p/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ record: expired }) });
    assert.equal(r.status, 400);
  } finally { await seed.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('standalone seed REJECTS records whose probe-back fails (directory poisoning) and never lists them', async () => {
  const probe = require('../src/net/p2p/bootstrap/probe'); const realProbe = probe.probePeerRecord; probe.probePeerRecord = async () => ({ verified: false, reason: 'unreachable' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-seed-poison-')); const seed = await startSeed(path.join(dir, 'seed.db'));
  try {
    const record = createPeerRecord({ peerId, multiaddrs: [`/ip4/8.8.8.8/tcp/28090/ws/p2p/${peerId}`] });
    const published = await publishPeerRecord(seed.base, record).catch(() => ({ accepted: 0 }));
    assert.equal(published.accepted || 0, 0);
    assert.equal((await (await fetch(seed.base + '/p2p/bootstrap')).json()).count, 0);
  } finally { probe.probePeerRecord = realProbe; await seed.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
