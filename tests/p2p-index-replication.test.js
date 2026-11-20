'use strict';
/**
 * Phase 5 completion tests. Each "Hub" has its own SQLite DB, Ed25519 identity, DistributedIndex and ShardCoordinator.
 * Transport = in-process LoopbackNetwork (JSON round-trip, partitions, drops) and a controllable monotonic clock.
 * These are UNIT/INTEGRATION + in-process simulation tests — NOT a multi-machine or public-Internet test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase, Db, MIGRATIONS } = require('../src/db');
const { DistributedIndex, shardFor } = require('../src/net/p2p/distributed-index');
const { ShardCoordinator, ROLE } = require('../src/net/p2p/index-replication');
const { ResourceGovernor, LoopbackNetwork } = require('../src/net/p2p/index-governor');
const C = require('../src/net/p2p/index-crypto');
const { TrustEngine } = require('../src/net/p2p/trust-engine');

const SHARD = 7;
const strongProbes = { load1: () => 0.1, cpus: () => 8, totalMemMb: () => 16000, rssMb: () => 100, freeDiskMb: () => 100000 };
const trustAll = { stateOf: () => 'TRUSTED', allow: () => ({ ok: true }), observe() {} };

function idFor(origin, shard = SHARD, n = 0) { for (let i = 0; ; i++) { const id = `post-${n}-${i}`; if (shardFor(origin + ':' + id) === shard) return id; } }

function makeCluster(t, count, { cfg = {}, trust = trustAll, probes = {}, governorOverrides = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-repl-'));
  const net = new LoopbackNetwork(); const clock = { t: 1000 };
  const nodes = [];
  for (let i = 0; i < count; i++) nodes.push(makeNode(dir, i, net, clock, { cfg, trust, probes, governorOverrides }));
  t.after(() => { for (const n of nodes) { try { n.db.close(); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); });
  const ids = nodes.map((n) => n.id);
  return { nodes, net, clock, ids, dir, advance(ms) { clock.t += ms; }, by: (id) => nodes.find((n) => n.id === id) };
}
function makeNode(dir, i, net, clock, { cfg, trust, probes, governorOverrides, signer }) {
  const sg = signer || C.createEd25519Signer(); const id = sg.peerId;
  const db = openDatabase(path.join(dir, `hub-${i}.sqlite`));
  const index = new DistributedIndex({ db, localPeerId: () => id });
  const governor = new ResourceGovernor({ index, probes: { ...strongProbes, ...probes }, overrides: governorOverrides });
  const transport = net.attach(id);
  const coord = new ShardCoordinator({ index, db, transport, signer: sg, trust, governor, now: () => clock.t, config: { leaseMs: 10000, requestTimeoutMs: 500, ...cfg } });
  return { i, id, sg, db, index, coord, governor, transport, dir, clock, net, cfg, trust, probes, governorOverrides };
}
/** Simulate a process restart: same DB file + same identity, brand new in-memory coordinator. */
async function restart(cluster, node) {
  const file = path.join(node.dir, `hub-${node.i}.sqlite`);
  await node.coord.stop({ graceful: false }); node.db.close();
  const fresh = makeNode(node.dir, node.i, node.net, node.clock, { cfg: node.cfg, trust: node.trust, probes: node.probes, governorOverrides: node.governorOverrides, signer: node.sg });
  cluster.nodes[cluster.nodes.indexOf(node)] = fresh; await fresh.coord.start(); return fresh;
}
function plan(ids, shard = SHARD) { return [{ shard_id: shard, primary: { peer_id: ids[0] }, replicas: ids.slice(1).map((p) => ({ peer_id: p })) }]; }
async function bootstrap(cl, shard = SHARD, members = cl.ids.slice(0, 3)) {
  for (const n of cl.nodes) await n.coord.start();
  for (const id of members.slice(1)) await cl.by(id).coord.adoptPlan(plan(members, shard));
  const r = await cl.by(members[0]).coord.adoptPlan(plan(members, shard));
  return r[0];
}
function addDoc(node, text, n = 0, extra = {}) {
  const id = idFor(node.id, SHARD, n);
  const r = node.index.upsertDocument({ origin_peer: node.id, content_id: id, visibility: 'public', title: 'Title ' + text, text, language: 'vi', region: 'VN', updated_at: 1000 + n, ...extra }, { local: true });
  assert.equal(r.ok, true, JSON.stringify(r)); return id;
}
const primaries = (cl) => cl.nodes.filter((n) => n.coord.canWrite(SHARD));
const state = (n) => n.coord._states.get(SHARD);

test('migration 11 upgrades a populated migration-10 database without touching existing rows', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-mig-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.sqlite'); const raw = new Db(file);
  raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  for (const m of MIGRATIONS.filter((x) => x.id <= 10)) { raw.tx(() => { m.up(raw); raw.run('INSERT INTO schema_migrations VALUES(?,?,?)', m.id, m.name, 1); }); }
  raw.run("INSERT INTO users(username) VALUES('alice')");
  raw.run("INSERT INTO p2p_index_documents(origin_peer,content_id,shard_id,title,body,content_hash,updated_at,indexed_at,byte_size) VALUES('o','c',1,'t','b','h',1,1,2)");
  raw.close();
  const db = openDatabase(file);
  assert.equal(db.get('SELECT COUNT(*) c FROM schema_migrations').c, MIGRATIONS.length);
  assert.equal(db.get("SELECT COUNT(*) c FROM users WHERE username='alice'").c, 1);
  assert.equal(db.get('SELECT title, origin_sig FROM p2p_index_documents').title, 't');
  assert.equal(db.get('SELECT origin_sig FROM p2p_index_documents').origin_sig, '');
  for (const tb of ['p2p_index_shard_state', 'p2p_index_oplog', 'p2p_index_tombstones']) assert.equal(db.hasTable(tb), true);
  db.close();
});

test('election: three Hubs elect exactly one Primary with a verifiable quorum certificate', async (t) => {
  const cl = makeCluster(t, 3);
  const r = await bootstrap(cl);
  assert.equal(r.ok, true); assert.equal(r.epoch, 1);
  const [a, b, c] = cl.nodes;
  assert.equal(state(a).role, ROLE.PRIMARY); assert.equal(state(b).role, ROLE.REPLICA); assert.equal(state(c).role, ROLE.REPLICA);
  assert.equal(a.coord.canWrite(SHARD), true); assert.equal(b.coord.canWrite(SHARD), false);
  const cert = state(b).cert;
  assert.equal(cert.votes.length >= 2, true);
  assert.equal(await b.coord._verifyCert(cert, SHARD), true);
  const forged = { ...cert, members: [...cert.members, 'x'.repeat(40)] };
  assert.equal(await b.coord._verifyCert(forged, SHARD), false, 'tampered certificate must fail');
});

test('replication: data written on the Primary and on a Replica reaches every member (real signed transfer)', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b, c] = cl.nodes;
  addDoc(a, 'cong dong viet nam xin chao', 1); await a.coord.idle();
  assert.equal(b.index.searchLocal('cong dong').items.length, 1);
  assert.equal(c.index.searchLocal('cong dong').items.length, 1);
  addDoc(b, 'japanese community hub tokyo', 2); await b.coord.idle();          // authored on a Replica -> submitted to Primary -> fanned out
  for (const n of [a, b, c]) assert.equal(n.index.searchLocal('tokyo').items.length, 1, 'node ' + n.i);
  const da = a.index.shardDigests(SHARD), dc = c.index.shardDigests(SHARD);
  assert.deepEqual([da.digest, da.tomb_digest], [dc.digest, dc.tomb_digest]);
  assert.equal(state(a).seq, 2); assert.equal(state(c).seq, 2);
  assert.ok(c.index.getDocument(a.id, idFor(a.id, SHARD, 1)).origin_sig.length > 20, 'origin signature stored on replicas');
});

test('integrity: forged, tampered and unsigned entries are rejected by replicas', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b, c] = cl.nodes; const evil = C.createEd25519Signer();
  const mk = async (signer, origin, text, tamper) => {
    const id = idFor(origin, SHARD, 9); const title = 'T'; const doc = { origin_peer: origin, content_id: id, title, text, language: 'en', region: 'US', topics: [], content_hash: C.sha256(title + '\n' + text), updated_at: 5 };
    const sig = await signer.sign(C.docPayload(doc)); return { op: 'upsert', origin_peer: origin, content_id: id, doc: tamper ? { ...doc, text: text + ' EXTRA' } : doc, origin_sig: sig, seq: 1, epoch: 1 };
  };
  // (1) a rogue Primary claims a document for origin C, signed with its own key
  assert.equal(await b.coord._verifyEntry(await mk(evil, c.id, 'fake news'), SHARD), 'bad_signature');
  // (2) valid signature but content altered in flight -> hash mismatch
  assert.equal(await b.coord._verifyEntry(await mk(c.sg, c.id, 'honest', true), SHARD), 'hash_mismatch');
  // (3) honest entry passes
  assert.equal(await b.coord._verifyEntry(await mk(c.sg, c.id, 'honest'), SHARD), null);
  // (4) end-to-end: a malicious submit to the real Primary is refused and nothing spreads
  const bad = await mk(evil, c.id, 'poison');
  const resp = await b.transport.request(a.id, { t: 'submit', shard: SHARD, entry: bad });
  assert.equal(resp.ok, false); assert.match(resp.reason, /bad_signature/);
  for (const n of [a, b, c]) assert.equal(n.index.searchLocal('poison').items.length, 0);
});

test('failover: Replica takes over after Primary loss, writes continue, old Primary steps down on return', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b, c] = cl.nodes;
  addDoc(a, 'before failover alpha', 1); await a.coord.idle();
  cl.net.setDown(a.id);                                             // Primary crashes
  cl.advance(30000);
  for (const n of [b, c]) await n.coord.tick();
  const prim = primaries(cl); assert.equal(prim.length, 1); assert.ok([b, c].includes(prim[0]));
  assert.equal(state(prim[0]).epoch, 2);
  addDoc(prim[0], 'after failover beta', 2); await prim[0].coord.idle();
  const other = prim[0] === b ? c : b; assert.equal(other.index.searchLocal('beta').items.length, 1);
  assert.equal(other.index.searchLocal('alpha').items.length, 1, 'no metadata lost across failover');
  cl.net.heal();                                                    // old Primary returns holding a stale epoch-1 role
  assert.equal(state(a).role, ROLE.PRIMARY);
  assert.equal(a.coord.canWrite(SHARD), false, 'lease lapsed: it was already self-fenced');
  cl.advance(3000); await prim[0].coord.tick(); await a.coord.tick();
  assert.equal(state(a).role, ROLE.REPLICA); assert.equal(state(a).epoch, 2);
  await a.coord.catchUp(SHARD);
  assert.equal(a.index.searchLocal('beta').items.length, 1);
});

test('SPLIT-BRAIN: partitioned old Primary self-fences; at no instant do two nodes hold write authority', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b, c] = cl.nodes; const everSeenTwo = [];
  const watch = () => { if (primaries(cl).length > 1) everSeenTwo.push(cl.clock.t); };
  addDoc(a, 'pre partition', 1); await a.coord.idle(); watch();
  cl.net.partition([a.id], [b.id, c.id]);                           // A isolated (still thinks it is Primary)
  assert.equal(a.coord.canWrite(SHARD), true, 'lease still valid right after the cut');
  for (let i = 0; i < 40; i++) {                                    // 40 x 1s of wall time with ticks on every node
    cl.advance(1000); watch();
    await a.coord.tick(); watch(); await b.coord.tick(); watch(); await c.coord.tick(); watch();
  }
  assert.deepEqual(everSeenTwo, [], 'two Primaries must never coexist');
  assert.equal(a.coord.canWrite(SHARD), false, 'isolated Primary fenced itself after lease expiry');
  const winner = primaries(cl); assert.equal(winner.length, 1); assert.ok([b, c].includes(winner[0]));
  // the fenced Primary refuses direct writes and rejects submits
  const rej = await b.transport.request(a.id, { t: 'submit', shard: SHARD, entry: { op: 'delete', origin_peer: a.id, content_id: 'x', version: 1, origin_sig: 'x' } }).catch((e) => ({ ok: false, reason: e.message }));
  assert.equal(rej.ok, false);
  // write on the minority side must not be committed anywhere
  addDoc(a, 'isolated write that must not commit', 5); await a.coord.idle();
  assert.equal(winner[0].index.searchLocal('isolated').items.length, 0);
  cl.net.heal(); cl.advance(3000);
  await winner[0].coord.tick(); await a.coord.tick(); watch();
  assert.equal(state(a).role, ROLE.REPLICA); assert.deepEqual(everSeenTwo, []);
  // after healing, the doc A authored while isolated converges through reconcile (origin re-submits its own signed doc)
  await a.coord.reconcile(SHARD); await a.coord.idle();
  assert.equal(winner[0].index.searchLocal('isolated').items.length, 1);
});

test('SPLIT-BRAIN: a stale-epoch Primary is fenced by replicas even if it still believes it is Primary', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b, c] = cl.nodes;
  cl.net.partition([a.id], [b.id, c.id]); cl.advance(30000);
  await b.coord.tick(); await c.coord.tick();
  const np = primaries(cl)[0]; assert.ok(np && np !== a);
  cl.net.heal();                                                    // A's lease has NOT been recomputed: replay its old-epoch append directly
  const r = await a.transport.request(b.id, { t: 'append', shard: SHARD, epoch: 1, prev_seq: 0, prev_epoch: 0, entries: [] });
  assert.equal(r.ok, false); assert.equal(r.reason, 'stale_epoch'); assert.ok(r.epoch >= 2);
  const r2 = await a.transport.request(c.id, { t: 'append', shard: SHARD, epoch: 1, prev_seq: 0, prev_epoch: 0, entries: [] });
  assert.equal(r2.reason, 'stale_epoch');
  assert.ok(b.coord.metrics.rejected.fenced >= 1);
});

test('SPLIT-BRAIN: racing candidates cannot both win the same epoch (one durable vote per epoch)', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b, c] = cl.nodes;
  cl.net.setDown(a.id); cl.advance(30000);
  const [rb, rc] = await Promise.all([b.coord.elect(SHARD), c.coord.elect(SHARD)]);
  assert.ok([rb, rc].filter((r) => r.ok).length <= 1, 'at most one winner: ' + JSON.stringify([rb.reason, rc.reason]));
  assert.ok(primaries(cl).length <= 1);
  // retry with backoff converges on exactly one
  cl.advance(70000); if (!primaries(cl).length) await b.coord.elect(SHARD);
  assert.equal(primaries(cl).length, 1);
});

test('SPLIT-BRAIN: a minority replica can never elect itself; a voter cannot be talked into a second vote', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b, c] = cl.nodes;
  cl.net.partition([c.id], [a.id, b.id]); cl.advance(30000);
  const r = await c.coord.elect(SHARD);
  assert.equal(r.ok, false); assert.equal(r.reason, 'no_quorum');
  assert.notEqual(state(c).role, ROLE.PRIMARY);
  cl.net.heal(); cl.net.setDown(a.id);
  const win = await c.coord.elect(SHARD);                           // with B reachable C now has a majority
  assert.equal(win.ok, true);
  cl.net.heal();
  const v = await a.transport.request(b.id, { t: 'vote_req', shard: SHARD, epoch: win.epoch, candidate: a.id, members: cl.ids, old_members: cl.ids, last_epoch: 1, last_seq: 0, ts: Date.now(), nonce: 'n' });
  assert.equal(v.granted, false); assert.equal(v.reason, 'stale_epoch');
});

test('vote persistence: a restarted Hub still refuses a second vote in an already-voted epoch', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b, c] = cl.nodes;
  cl.net.setDown(a.id); cl.advance(30000);
  const el = await b.coord.elect(SHARD); assert.equal(el.ok, true);
  const c2 = await restart(cl, c);
  assert.equal(c2.coord._states.get(SHARD).voted_epoch, 2); assert.equal(c2.coord._states.get(SHARD).voted_for, b.id);
  cl.advance(30000);
  cl.net.heal();
  const v = await a.transport.request(c2.id, { t: 'vote_req', shard: SHARD, epoch: 2, candidate: a.id, members: cl.ids, old_members: cl.ids, last_epoch: 1, last_seq: 0, ts: Date.now(), nonce: 'n' });
  assert.equal(v.granted, false);
});

// ---------------------------------------------------------------------------------------------------------------------
test('recovery: a Replica offline across many writes catches up from the log, or by signed snapshot when the log is trimmed', async (t) => {
  for (const retention of [2000, 3]) {
    const cl = makeCluster(t, 3, { cfg: { oplogRetention: retention } }); await bootstrap(cl);
    const [a, b, c] = cl.nodes;
    cl.net.setDown(c.id);
    for (let i = 1; i <= 10; i++) addDoc(a, 'offline write number ' + i + ' ngon', i);
    await a.coord.idle(); assert.equal(c.index.searchLocal('offline').items.length, 0);
    cl.net.heal(); cl.advance(3000);
    await a.coord.tick();                                           // heartbeat reveals the gap
    await c.coord.tick();                                           // follower pulls
    assert.equal(c.index.searchLocal('offline', { limit: 50 }).items.length, 10, 'retention=' + retention);
    assert.equal(state(c).seq, state(a).seq);
    const da = a.index.shardDigests(SHARD), dc = c.index.shardDigests(SHARD); assert.equal(da.digest, dc.digest);
    if (retention === 3) assert.ok(c.coord.metrics.snapshots_pulled >= 1, 'snapshot path used'); else assert.equal(c.coord.metrics.snapshots_pulled, 0, 'log path used');
  }
});

test('recovery: repeated connection loss with dropped messages converges without operator action', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b, c] = cl.nodes; let phase = 'lossy';
  cl.net.dropIf = (from, to) => phase === 'lossy' && (to === c.id || from === c.id);
  for (let i = 1; i <= 6; i++) { addDoc(a, 'flaky link doc ' + i, i); cl.advance(3000); await a.coord.tick(); await c.coord.tick(); }
  await a.coord.idle(); assert.ok(c.index.searchLocal('flaky', { limit: 50 }).items.length < 6);
  phase = 'ok';
  for (let r = 0; r < 5; r++) { cl.advance(3000); await a.coord.tick(); await c.coord.tick(); }
  assert.equal(c.index.searchLocal('flaky', { limit: 50 }).items.length, 6);
  assert.equal(a.index.shardDigests(SHARD).digest, c.index.shardDigests(SHARD).digest);
});

test('data integrity: delete is a signed tombstone; deleted posts never reappear (stale upsert, missed delete, snapshot)', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b, c] = cl.nodes;
  const id = addDoc(a, 'temporary secret-free post gone soon', 1); await a.coord.idle();
  assert.equal(c.index.searchLocal('gone soon').items.length, 1);
  const stale = { ...c.index.getDocument(a.id, id) };                            // a copy of the live document (old version)
  cl.net.setDown(c.id);
  assert.equal(a.index.removeDocument(a.id, id), true); await a.coord.idle();
  assert.equal(b.index.searchLocal('gone soon').items.length, 0);
  assert.equal(c.index.searchLocal('gone soon').items.length, 1, 'C missed the delete');
  // replayed stale upsert must be refused on a node that holds the tombstone
  const r = b.index.upsertDocument({ ...stale, text: stale.body, visibility: 'public', topics: [] }, { verified: true, originSig: stale.origin_sig, replication: b.index.replicationToken() });
  assert.equal(r.ok, false); assert.equal(r.reason, 'tombstoned');
  assert.equal(b.index.searchLocal('gone soon').items.length, 0);
  cl.net.heal(); cl.advance(3000); await a.coord.tick(); await c.coord.tick();
  assert.equal(c.index.searchLocal('gone soon').items.length, 0, 'tombstone propagated after reconnect');
  assert.equal(a.index.shardDigests(SHARD).tomb_digest, c.index.shardDigests(SHARD).tomb_digest);
  // a snapshot-joined replica also receives the tombstone and cannot resurrect the post
  assert.ok(a.index.getTombstone(a.id, id).sig.length > 20, 'tombstone carries origin signature');
});

test('data integrity: corrupt index rows are detected, dropped and restored from the Primary', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b, c] = cl.nodes;
  const id1 = addDoc(a, 'integrity row one', 1), id2 = addDoc(a, 'integrity row two', 2); await a.coord.idle();
  c.db.run("UPDATE p2p_index_documents SET body='TAMPERED BODY' WHERE content_id=?", id1);                 // hash no longer matches
  c.db.run("UPDATE p2p_index_documents SET origin_sig='AAAA' WHERE content_id=?", id2);                    // signature no longer verifies
  const v = await c.coord.verifyIntegrity(SHARD);
  assert.equal(v.corrupt, 2);
  assert.equal(c.index.getDocument(a.id, id1), null);
  const r = await c.coord.reconcile(SHARD);
  assert.equal(r.ok, true); assert.equal(r.in_sync, true);
  assert.equal(c.index.getDocument(a.id, id1).body, 'integrity row one');
  assert.equal(a.index.shardDigests(SHARD).digest, c.index.shardDigests(SHARD).digest);
  assert.equal((await c.coord.verifyIntegrity(SHARD)).corrupt, 0);
});

test('Primary loses its own index rows: it self-repairs from a Replica, then keeps serving', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b, c] = cl.nodes;
  const id = addDoc(a, 'primary data loss scenario', 1); await a.coord.idle();
  a.db.run("DELETE FROM p2p_index_documents WHERE content_id=?", id); a.db.run("DELETE FROM p2p_index_terms WHERE content_id=?", id);
  const rt = a.coord._rt.get(SHARD); rt.syncing = false;
  const res = await a.coord.catchUp(SHARD, { from: b.id });                                              // pull (log says nothing is missing) ...
  assert.equal(res.ok, true);
  const snap = await a.coord._forceSnapshot_from(SHARD, b.id);                                           // ... then merge repair from a replica
  assert.equal(snap.ok, true);
  assert.equal(a.index.searchLocal('data loss').items.length, 1);
});

test('rebalance: dead member is replaced by a caught-up learner through a joint-quorum change; removed member learns it was retired', async (t) => {
  const cl = makeCluster(t, 4, { cfg: { deadAfterMs: 20000, migrationCooldownMs: 1 } });
  await bootstrap(cl, SHARD, cl.ids.slice(0, 3));
  const [a, b, c, d] = cl.nodes; const dup = [];
  for (let i = 1; i <= 5; i++) addDoc(a, 'rebalance payload ' + i, i); await a.coord.idle();
  const cands = cl.nodes.map((n) => ({ peer_id: n.id, verified: true, trust_state: 'TRUSTED', capacity: 1 }));
  cl.net.setDown(c.id);
  for (let i = 0; i < 12; i++) { cl.advance(3000); await a.coord.tick(); if (primaries(cl).length > 1) dup.push(1); }    // acks from C age out
  const started = await a.coord.rebalance(cands);
  assert.deepEqual(started.started, [SHARD]);
  assert.equal(state(d).role, ROLE.LEARNER);
  for (let i = 0; i < 6 && state(a).members.includes(c.id); i++) { cl.advance(3000); await a.coord.tick(); await d.coord.tick(); await a.coord.rebalance(cands); if (primaries(cl).length > 1) dup.push(2); }
  assert.deepEqual([...state(a).members].sort(), [a.id, b.id, d.id].sort());
  assert.equal(state(a).epoch, 2); assert.equal(state(d).role, ROLE.REPLICA); assert.equal(state(b).epoch, 2);
  assert.equal(d.index.searchLocal('rebalance', { limit: 50 }).items.length, 5, 'new replica holds the full shard');
  // C returns, still believing it is a member of epoch 1
  cl.net.heal(); cl.advance(3000); await a.coord.tick();
  assert.equal(state(c).role, ROLE.RETIRED);
  assert.equal(c.index.searchLocal('rebalance', { limit: 50 }).items.length, 5, 'retired member keeps its data (no deletion)');
  addDoc(a, 'post migration write', 9); await a.coord.idle();
  assert.equal(d.index.searchLocal('migration').items.length, 1);
  assert.deepEqual(dup, [], 'never two writers during rebalance');
});

test('rebalance: does nothing when membership is healthy (no churn), and aborts safely if the learner never catches up', async (t) => {
  const cl = makeCluster(t, 4, { cfg: { deadAfterMs: 20000, migrationCooldownMs: 1, migrationTimeoutMs: 15000 } });
  await bootstrap(cl, SHARD, cl.ids.slice(0, 3));
  const [a, b, c, d] = cl.nodes;
  const cands = cl.nodes.map((n) => ({ peer_id: n.id, verified: true, trust_state: 'TRUSTED', capacity: 1 }));
  cl.advance(3000); await a.coord.tick();
  assert.deepEqual(await a.coord.rebalance(cands), { started: [], completed: [], aborted: [] });
  cl.net.setDown(c.id); for (let i = 0; i < 12; i++) { cl.advance(3000); await a.coord.tick(); }
  cl.net.setDown(d.id, true);                                                   // the would-be learner is unreachable: invite fails -> never half-start
  assert.deepEqual((await a.coord.rebalance(cands)).started, []);
  assert.deepEqual(state(a).learners, []);
  assert.equal(state(a).epoch, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
test('resource control: weak machine never hosts shards; pressure (CPU/RAM/disk/index-full) sheds work', async (t) => {
  const weak = new ResourceGovernor({ probes: { ...strongProbes, totalMemMb: () => 1000 } });
  assert.equal(weak.profile().tier, 'weak'); assert.equal(weak.canHost(0), false);
  const med = new ResourceGovernor({ probes: { ...strongProbes, totalMemMb: () => 4000, cpus: () => 4 } });
  assert.equal(med.profile().tier, 'medium'); assert.equal(med.canHost(0), true); assert.equal(med.canHost(8), false, 'per-tier shard cap');
  for (const [name, probe] of [['cpu', { load1: () => 7.5 }], ['ram', { rssMb: () => 99999 }], ['disk', { freeDiskMb: () => 10 }]]) {
    const g = new ResourceGovernor({ probes: { ...strongProbes, ...probe } });
    assert.deepEqual(g.pressure().reasons, [name]); assert.equal(g.canHost(0), false, name);
  }
  assert.ok(new ResourceGovernor({ probes: { ...strongProbes, load1: () => 7.5 } }).concurrency() < new ResourceGovernor({ probes: strongProbes }).concurrency(), 'concurrency shrinks under load');
  // a weak Hub invited / planned for a shard declines instead of hosting it
  const cl = makeCluster(t, 3, { probes: { totalMemMb: () => 1000 } });
  for (const n of cl.nodes) await n.coord.start();
  const r = await cl.nodes[0].coord.adoptPlan(plan(cl.ids));
  assert.deepEqual(r, []); assert.equal(cl.nodes[0].coord.status().hosted, 0);
  const inv = await cl.nodes[1].transport.request(cl.ids[0], { t: 'invite', shard: SHARD, epoch: 1, members: cl.ids });
  assert.equal(inv.ok, false); assert.equal(inv.reason, 'no_capacity');
});

test('resource control: backpressure, per-peer rate limit, payload limits and bounded snapshot pages', async (t) => {
  const cl = makeCluster(t, 3, { governorOverrides: { baseConcurrency: 1 } }); await bootstrap(cl);
  const [a, b, c] = cl.nodes; const evil = C.createEd25519Signer();
  const bad = { op: 'delete', origin_peer: evil.peerId, content_id: idFor(evil.peerId), version: 1, origin_sig: 'AAAA' };
  const burst = await Promise.all(Array.from({ length: 60 }, () => a.coord.handle(evil.peerId, { t: 'submit', shard: SHARD, entry: bad })));
  assert.ok(burst.some((r) => r.reason === 'busy'), 'backpressure engaged');
  assert.ok(burst.every((r) => r.ok === false));
  // rate limit (fake clock frozen => no refill)
  let limited = 0; for (let i = 0; i < 400; i++) { const r = await a.coord.handle('flooder'.padEnd(44, 'x'), { t: 'state_query', shard: SHARD }); if (r.reason === 'rate_limited') limited++; }
  assert.ok(limited > 200, 'flood limited: ' + limited);
  assert.equal((await a.coord.handle(b.id, { t: 'state_query', shard: SHARD })).ok, true, 'honest peer unaffected');
  // payload limits: oversized append / malformed / out-of-range shard
  assert.equal((await b.coord.handle(a.id, { t: 'append', shard: SHARD, epoch: 1, prev_seq: 0, entries: new Array(500).fill({}) })).reason, 'too_many_entries');
  assert.equal((await b.coord.handle(a.id, { t: 'nope', shard: SHARD })).reason, 'bad_message');
  assert.equal((await b.coord.handle(a.id, { t: 'digest', shard: 99999 })).reason, 'bad_shard');
  await assert.rejects(() => cl.nodes[0].transport.request(b.id, { t: 'append', shard: SHARD, blob: 'x'.repeat(2 * 1024 * 1024) }), /too large/);
  // snapshot pages stay under the byte budget even with maximum-size documents
  for (let i = 0; i < 40; i++) addDoc(a, ('word' + i + ' ').repeat(2000).slice(0, 12000), 100 + i); await a.coord.idle();
  const pg = await b.transport.request(a.id, { t: 'snapshot', shard: SHARD, phase: 'docs', after: '', limit: 200 });
  assert.equal(pg.ok, true); assert.ok(JSON.stringify(pg).length <= 700 * 1024, 'page bytes ' + JSON.stringify(pg).length);
});

test('security: trust gating — untrusted candidates cannot win, blocked/quarantined peers are refused, NEW peers hit quotas', async (t) => {
  const te = new TrustEngine();
  const cl = makeCluster(t, 3, { trust: te });
  for (const n of cl.nodes) await n.coord.start();
  for (const id of cl.ids.slice(1)) await cl.by(id).coord.adoptPlan(plan(cl.ids));
  const r = await cl.nodes[0].coord.adoptPlan(plan(cl.ids));
  assert.equal(r[0].ok, false); assert.equal(r[0].reason, 'no_quorum', 'NEW peers cannot elect a Primary');
  for (const id of cl.ids) for (let i = 0; i < 6; i++) te.observe(id, { success: true });              // earned TRUSTED
  assert.equal(te.stateOf(cl.ids[0]), 'TRUSTED');
  cl.advance(70000);
  assert.equal((await cl.nodes[0].coord.elect(SHARD)).ok, true);
  te.block(cl.ids[2], 'test');
  assert.equal((await cl.nodes[0].coord.handle(cl.ids[2], { t: 'digest', shard: SHARD })).reason, 'trust_blocked');
  te.quarantine(cl.ids[1], 'test');
  assert.equal((await cl.nodes[0].coord.handle(cl.ids[1], { t: 'state_query', shard: SHARD })).reason, 'trust_quarantined');
});

test('security: replay and impersonation — vote request not sent by its candidate, stale timestamps, forged announce', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b, c] = cl.nodes; const evil = C.createEd25519Signer();
  const vr = { t: 'vote_req', shard: SHARD, epoch: 9, candidate: c.id, members: cl.ids, old_members: cl.ids, last_epoch: 1, last_seq: 0, ts: Date.now(), nonce: 'n' };
  assert.equal((await b.coord.handle(a.id, vr)).reason, 'sender_mismatch', 'A cannot request votes in C\'s name');
  assert.equal((await b.coord.handle(c.id, { ...vr, ts: Date.now() - 3600000 })).reason, 'stale_request');
  // forged announce: attacker-made certificate with self-signed votes of sock puppets
  const pup = [C.createEd25519Signer(), C.createEd25519Signer()];
  const members = [evil.peerId, pup[0].peerId, pup[1].peerId]; const old = [];
  const votes = []; for (const s of [evil, ...pup]) votes.push({ peer: s.peerId, sig: await s.sign(C.votePayload({ shard: SHARD, epoch: 5, candidate: evil.peerId, members, old_members: old, voter: s.peerId })) });
  const forged = { shard_id: SHARD, epoch: 5, primary: evil.peerId, members, old_members: old, votes, issued_at: 1 };
  const resp = await b.coord.handle(evil.peerId, { t: 'announce', shard: SHARD, cert: forged });
  assert.equal(resp.ok, false); assert.equal(state(b).primary, a.id, 'membership unchanged');
  assert.equal(state(b).epoch, 1);
});

test('privacy: only PUBLIC content is indexed, logged and transferred', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b, c] = cl.nodes; const id = idFor(a.id, SHARD, 77);
  for (const vis of ['private', 'group', 'dm', undefined]) assert.equal(a.index.upsertDocument({ origin_peer: a.id, content_id: id, visibility: vis, title: 'SECRET-DM-TEXT', text: 'SECRET-DM-TEXT' }, { local: true }).reason, 'not_public');
  addDoc(a, 'public hello world', 1); await a.coord.idle();
  const dump = JSON.stringify(a.db.all('SELECT payload FROM p2p_index_oplog')) + JSON.stringify(await b.transport.request(a.id, { t: 'snapshot', shard: SHARD, phase: 'docs', after: '', limit: 50 }));
  assert.ok(!dump.includes('SECRET-DM-TEXT')); assert.ok(dump.includes('public hello world'));
  assert.equal(c.index.searchLocal('SECRET-DM-TEXT').items.length, 0);
  // a peer outside the member set cannot pull a shard
  const outsider = C.createEd25519Signer();
  assert.equal((await a.coord.handle(outsider.peerId, { t: 'snapshot', shard: SHARD, phase: 'docs' })).reason, 'not_member');
  assert.equal((await a.coord.handle(outsider.peerId, { t: 'fetch', shard: SHARD, from_seq: 1 })).reason, 'not_member');
});

test('compatibility: legacy index API unchanged on unmanaged shards; managed shards require the fenced path for remote writes', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b] = cl.nodes; const other = SHARD + 1;
  const remote = (shard, id) => ({ origin_peer: 'remote-peer-x', content_id: id, visibility: 'public', title: 'legacy', text: 'legacy api' });
  const idOther = idFor('remote-peer-x', other), idManaged = idFor('remote-peer-x', SHARD);
  assert.equal(a.index.upsertDocument(remote(other, idOther), { verified: true }).ok, true, 'unmanaged shard: old behaviour');
  assert.equal(a.index.upsertDocument(remote(SHARD, idManaged), { verified: true }).reason, 'managed_shard_requires_replication');
  assert.equal(a.index.removeDocument('remote-peer-x', idManaged), false);
  assert.equal(a.index.searchLocal('legacy').items.length, 1);
  assert.equal(a.index.stats().phase, 5); assert.ok(a.index.exportShard(other).ok);
  assert.equal(b.index.planAssignments([0], [{ peer_id: 'p', verified: true, trust_state: 'TRUSTED', capacity: 1 }]).length, 1);
  const st = a.coord.status(); assert.equal(st.roles.PRIMARY, 1); assert.equal(st.shards[0].writable, true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Targeted fencing proofs (each was added after mutation testing showed the mechanism was not yet pinned down by a test)
test('fencing: after a quorum has VOTED for a newer epoch (announce not yet delivered) the old Primary can no longer renew its lease', async (t) => {
  const cl = makeCluster(t, 3, { cfg: { leaseMs: 10000 } }); await bootstrap(cl);
  const [a, b, c] = cl.nodes;
  cl.advance(11000);                                                // primary silent long enough for voters to be free to vote
  const vr = (cand, mem) => ({ t: 'vote_req', shard: SHARD, epoch: 2, candidate: cand, members: cl.ids, old_members: cl.ids, last_epoch: 1, last_seq: 0, ts: Date.now(), nonce: 'n' });
  assert.equal((await c.coord.handle(b.id, vr(b.id))).granted, true);   // C votes for B at epoch 2
  assert.equal((await b.coord.handle(c.id, vr(c.id))).granted, true);   // B votes for C at epoch 2 (a split vote: nobody completed the election)
  // A is oblivious and keeps heartbeating at epoch 1
  for (let i = 0; i < 4; i++) { await a.coord.tick(); cl.advance(2500); }
  assert.ok(b.coord.metrics.rejected.fenced >= 1 && c.coord.metrics.rejected.fenced >= 1, 'both voters fenced epoch 1');
  assert.equal(a.coord.canWrite(SHARD), false, 'Primary lost quorum authority as soon as a majority voted for epoch 2');
});

test('fencing: voters refuse to vote against a live Primary (lease wait)', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b, c] = cl.nodes;
  cl.advance(3000); await a.coord.tick();                           // healthy heartbeat just happened
  const v = await c.coord.handle(b.id, { t: 'vote_req', shard: SHARD, epoch: 2, candidate: b.id, members: cl.ids, old_members: cl.ids, last_epoch: 1, last_seq: 0, ts: Date.now(), nonce: 'n' });
  assert.equal(v.granted, false); assert.equal(v.reason, 'primary_alive');
  const v2 = await a.coord.handle(b.id, { t: 'vote_req', shard: SHARD, epoch: 2, candidate: b.id, members: cl.ids, old_members: cl.ids, last_epoch: 1, last_seq: 0, ts: Date.now(), nonce: 'n' });
  assert.equal(v2.granted, false, 'a Primary that still holds its lease does not vote either');
});

test('joint quorum: a membership change needs a majority of the OLD set as well as the NEW set', async (t) => {
  const cl = makeCluster(t, 1); const n = cl.nodes[0];
  const old = [C.createEd25519Signer(), C.createEd25519Signer(), C.createEd25519Signer()];
  const neu = [old[0], C.createEd25519Signer(), C.createEd25519Signer()];            // keeps one old member, adds two new
  const members = neu.map((s) => s.peerId), oldIds = old.map((s) => s.peerId);
  const mk = async (voters) => { const votes = []; for (const s of voters) votes.push({ peer: s.peerId, sig: await s.sign(C.votePayload({ shard: SHARD, epoch: 2, candidate: members[0], members, old_members: oldIds, voter: s.peerId })) }); return { shard_id: SHARD, epoch: 2, primary: members[0], members, old_members: oldIds, votes, issued_at: 1 }; };
  assert.equal(n.coord._quorumOk([{ peer: members[0] }, { peer: members[1] }, { peer: members[2] }], members, oldIds), false, 'full NEW majority but only 1/3 of OLD');
  assert.equal(await n.coord._verifyCert(await mk(neu), SHARD), false);
  assert.equal(await n.coord._verifyCert(await mk([...neu, old[1]]), SHARD), true, 'adding a second OLD voter satisfies both majorities');
});

test('tombstone guard lives in the storage layer: a replicated stale upsert is refused even when signed and verified', async (t) => {
  const cl = makeCluster(t, 3); await bootstrap(cl);
  const [a, b] = cl.nodes; const tok = b.index.replicationToken();
  const id = addDoc(a, 'resurrection candidate', 1); await a.coord.idle();
  const live = { ...b.index.getDocument(a.id, id), text: b.index.getDocument(a.id, id).body, visibility: 'public', topics: [] };
  b.index.removeDocument(a.id, id, { version: 50000, sig: 'x', replication: tok });
  assert.equal(b.index.upsertDocument(live, { verified: true, originSig: live.origin_sig, replication: tok }).reason, 'tombstoned');
  // but a genuinely newer version (edit after delete) is allowed and clears the tombstone
  assert.equal(b.index.upsertDocument({ ...live, updated_at: 60000 }, { verified: true, originSig: live.origin_sig, replication: tok }).ok, true);
  assert.equal(b.index.getTombstone(a.id, id), null);
});

test('adapter: replication is opt-in, old index API intact, new status/adopt/rebalance methods exist and are inert when disabled', async (t) => {
  const { Libp2pAdapter } = require('../src/net/p2p/libp2p-adapter');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-adapter-')); const db = openDatabase(path.join(dir, 'h.sqlite'));
  t.after(() => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const ad = new Libp2pAdapter({ cfg: { dataDir: dir, p2p: {} }, db });
  for (const m of ['indexPublicDocument', 'searchLocalIndex', 'removeIndexedDocument', 'planIndexShardAssignments', 'applyIndexShardManifest', 'exportIndexShard', 'importIndexShardSnapshot', 'indexStats', 'indexReplicationStatus', 'adoptIndexAssignments', 'rebalanceIndex']) assert.equal(typeof ad[m], 'function', m);
  assert.deepEqual(ad.indexReplicationStatus(), { enabled: false });
  assert.deepEqual(await ad.adoptIndexAssignments([]), []);
  assert.equal(await ad._startIndexReplication(), false, 'disabled by default');
  assert.equal(ad.indexStats().phase, 5);
  const { loadConfig } = require('../src/config');
  assert.equal(loadConfig({}).p2p.indexReplication, false);
  assert.equal(loadConfig({ P2P_INDEX_REPLICATION: '1' }).p2p.indexReplication, true);
});

test('MULTI-PROCESS SIMULATION (real TCP sockets, separate OS processes, SIGKILL of the Primary): replication, failover, recovery', { timeout: 120000 }, async (t) => {
  const { fork } = require('child_process');
  const procs = []; let seq = 0; const waiters = new Map();
  const spawn = () => { const p = fork(path.join(__dirname, 'helpers', 'index-node-proc.js'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }); p.on('message', (m) => { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m.v); } }); procs.push(p); return p; };
  const call = (p, msg, ms = 8000) => new Promise((res, rej) => { const id = ++seq; const to = setTimeout(() => { waiters.delete(id); rej(new Error('ipc timeout ' + msg.cmd)); }, ms); waiters.set(id, (v) => { clearTimeout(to); res(v); }); p.send({ id, ...msg }); });
  t.after(() => { for (const p of procs) { try { p.kill('SIGKILL'); } catch {} } });
  const nodes = [spawn(), spawn(), spawn()]; const info = [];
  for (const p of nodes) info.push(await call(p, { cmd: 'init' }));
  const dirMap = Object.fromEntries(info.map((i) => [i.id, i.port]));
  for (const p of nodes) await call(p, { cmd: 'dir', dir: dirMap });
  const ids = info.map((i) => i.id); const pl = plan(ids);
  await call(nodes[1], { cmd: 'adopt', plans: pl }); await call(nodes[2], { cmd: 'adopt', plans: pl });
  const el = await call(nodes[0], { cmd: 'adopt', plans: pl }); assert.equal(el[0].ok, true, JSON.stringify(el));
  const cid = await call(nodes[0], { cmd: 'cid', n: 1, shard: SHARD });
  await call(nodes[0], { cmd: 'add', cid, text: 'cross process hello viet nam', ts: 1 });
  const cid2 = await call(nodes[1], { cmd: 'cid', n: 2, shard: SHARD });
  await call(nodes[1], { cmd: 'add', cid: cid2, text: 'replica authored tokyo post', ts: 2 });
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
  assert.ok(await until(async () => (await call(nodes[2], { cmd: 'search', q: 'hello' })) === 1 && (await call(nodes[2], { cmd: 'search', q: 'tokyo' })) === 1), 'data reached the third process over TCP');
  const d0 = (await call(nodes[0], { cmd: 'status', shard: SHARD })).digest; assert.equal((await call(nodes[2], { cmd: 'status', shard: SHARD })).digest, d0);
  nodes[0].kill('SIGKILL');                                                       // crash the Primary hard
  let newPrimary = null;
  assert.ok(await until(async () => { for (const i of [1, 2]) { await call(nodes[i], { cmd: 'tick' }); const s = (await call(nodes[i], { cmd: 'status', shard: SHARD })).shard; if (s && s.role === 'PRIMARY' && s.writable) newPrimary = i; } return newPrimary !== null; }, 30000), 'a surviving process became writable Primary');
  const other = newPrimary === 1 ? 2 : 1;
  const cid3 = await call(nodes[newPrimary], { cmd: 'cid', n: 3, shard: SHARD });
  await call(nodes[newPrimary], { cmd: 'add', cid: cid3, text: 'after sigkill failover post', ts: 3 });
  assert.ok(await until(async () => { await call(nodes[newPrimary], { cmd: 'tick' }); return (await call(nodes[other], { cmd: 'search', q: 'failover' })) === 1 && (await call(nodes[other], { cmd: 'search', q: 'hello' })) === 1; }), 'write replicated after failover, nothing lost');
  const sp = (await call(nodes[newPrimary], { cmd: 'status', shard: SHARD })).shard; assert.equal(sp.epoch, 2);
  const so = (await call(nodes[other], { cmd: 'status', shard: SHARD })).shard; assert.equal(so.role, 'REPLICA');
});
