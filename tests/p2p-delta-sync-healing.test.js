'use strict';
/**
 * Phase 7 tests — delta sync, tombstones, divergence detection, self-healing. Real Hubs (HTTP federation, SQLite, signed ledger) are used
 * wherever the behaviour lives in the Hub; the search layer uses the in-process LoopbackNetwork. None of this is a multi-machine test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { startHub, Client, waitFor } = require('./helpers');
const { HealingSupervisor, Backoff, RetryBudget } = require('../src/net/p2p/self-healing');
const { AntiEntropy } = require('../src/federation/delta');
const { openDatabase, Db, MIGRATIONS } = require('../src/db');

const PW = 'correct-horse-9';
const RL = { general: 50000, write: 50000, login: 5000, upload: 500, federation: 50000, assistant: 50 };
const BASE = { allowRegistration: true, contentSync: 'trusted', rateLimit: RL, syncIntervalMs: 3600000, antiEntropyMs: 3600000000, healing: { intervalMs: 0, cycleBudgetMs: 2000 } };
const hubs = [];
const mk = async (over = {}) => { const h = await startHub({ ...BASE, ...over }); hubs.push(h); return h; };
test.after(async () => { for (const h of hubs) { try { await h.stop(); } catch { /* ignore */ } } });

/** S = source Hub (owner alice), R = receiver Hub (owner carol) syncing S as a trusted peer. */
async function pair(nPosts = 3) {
  const S = await mk(); const a = new Client(S.base); await a.setup('alice', PW);
  const aliceId = (await a.get('/api/me')).json.user.account_id; const ids = [];
  for (let i = 0; i < nPosts; i++) ids.push((await a.post('/api/posts', { content: 'alice post ' + i })).json.event_id || null);
  const R = await mk(); const c = new Client(R.base); await c.setup('carol', PW);
  const p = R.peers.add(S.base, { state: 'trusted' }); R.peers.setPeerSync(p.id, true);
  const back = S.peers.add(R.peers.self().account + '@' + R.base, { state: 'trusted' }); S.peers.setPeerSync(back.id, true);
  await S.peers.syncPeer(S.peers.get(back.id)).catch(() => {});
  const sync = async () => { await waitFor(() => !R.peers.inflight.has(p.id), 8000, 20); return R.peers.syncPeer(R.peers.get(p.id)); };
  S.peers.poke = () => {};   // deterministic tests: the origin does not nudge the receiver
  const hookAE = R.peers.antiEntropy; R.peers.antiEntropy = null;   // background anti-entropy is exercised by its own test
  const first = await sync(); assert.equal(first.ok, true, JSON.stringify(first));
  let delivered = 0; const real = R.peers.call.bind(R.peers);
  R.peers.call = async (...args) => { const r = await real(...args); if (r && Array.isArray(r.events)) delivered += r.events.length; return r; };
  return { S, R, a, c, aliceId, peer: p, hookAE, sync, delivered: () => delivered, resetDelivered: () => { delivered = 0; }, real };
}
const postId = (hub, text) => hub.db.get('SELECT event_id FROM posts WHERE content=?', text)?.event_id;
const fp = (db) => JSON.stringify(db.get('SELECT COUNT(*) c, MAX(lid) m, SUM(LENGTH(body)) s FROM events'));

// ============================================================================================================ migration
test('migration 12 upgrades a populated migration-11 database without touching existing rows', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-mig-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = new Db(path.join(dir, 'old.sqlite'));
  raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  for (const m of MIGRATIONS.filter((x) => x.id <= 11)) raw.tx(() => { m.up(raw); raw.run('INSERT INTO schema_migrations VALUES(?,?,?)', m.id, m.name, 1); });
  raw.run("INSERT INTO users(username) VALUES('alice')"); raw.run("INSERT INTO remote_actors(actor_id,head_seq,fetched_at) VALUES('x',5,9)"); raw.close();
  const db = openDatabase(path.join(dir, 'old.sqlite'));
  assert.equal(db.get('SELECT COUNT(*) c FROM schema_migrations').c, MIGRATIONS.length);
  assert.equal(db.get("SELECT COUNT(*) c FROM users WHERE username='alice'").c, 1); assert.equal(db.get("SELECT head_seq FROM remote_actors WHERE actor_id='x'").head_seq, 5);
  for (const tb of ['remote_tombstones', 'integrity_findings', 'events_quarantine']) assert.equal(db.hasTable(tb), true); assert.equal(db.hasColumn('remote_actors', 'snap_seq'), true);
  db.close();
});

// ============================================================================================================ GATE 1: nothing unchanged is downloaded again
test('GATE delta: a second ledger sync transfers nothing; a new post transfers exactly that post; resume after offline continues from the cursor', async () => {
  const x = await pair(4); const { S, R, a, peer } = x;
  x.resetDelivered(); const r2 = await x.sync();
  assert.equal(r2.ok, true); assert.equal(r2.accepted, 0); assert.equal(r2.duplicate, 0, 'no event is sent twice'); assert.equal(x.delivered(), 0, 'zero events on the wire when nothing changed');
  await a.post('/api/posts', { content: 'one new post' }); x.resetDelivered();
  const r3 = await x.sync(); assert.equal(r3.accepted, 1); assert.equal(r3.duplicate, 0); assert.equal(x.delivered(), 1, 'delta = exactly the new event');
  // offline period: many failed attempts, bounded by back-off, nothing lost afterwards
  const realT = R.peers.transport; let attempts = 0; R.peers.transport = { request: async () => { attempts++; throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); } };
  for (let i = 0; i < 3; i++) await a.post('/api/posts', { content: 'while offline ' + i });
  const f1 = await R.peers.syncPeer(R.peers.get(peer.id)); assert.equal(f1.ok, false);
  const row1 = R.peers.get(peer.id); assert.equal(row1.fail_streak, 1); assert.ok(row1.next_retry_at > Date.now());
  const before = attempts; for (let i = 0; i < 25; i++) await R.peers.tick();
  assert.equal(attempts, before, 'no retry storm: ticks respect the back-off window');
  const delays = []; for (let i = 0; i < 6; i++) { await R.peers.syncPeer(R.peers.get(peer.id)); const r = R.peers.get(peer.id); delays.push(r.next_retry_at - Date.now()); }
  assert.ok(delays.every((d) => d <= R.cfg.backoffMaxMs), 'capped'); assert.ok(delays[5] > delays[0], 'exponential growth: ' + delays.map((d) => Math.round(d / 1000)));
  R.peers.transport = realT; R.db.run('UPDATE peers SET next_retry_at=0 WHERE id=?', peer.id); x.resetDelivered();
  const back = await x.sync(); assert.equal(back.ok, true); assert.equal(back.accepted, 3); assert.equal(back.duplicate, 0); assert.equal(R.peers.get(peer.id).fail_streak, 0);
  assert.equal(R.db.get('SELECT COUNT(*) c FROM events WHERE actor_id=?', x.aliceId).c, S.db.get('SELECT COUNT(*) c FROM events WHERE actor_id=?', x.aliceId).c, 'identical event sets after catching up');
});
test('GATE delta: profile snapshots are delta fetched — unchanged origin = nothing downloaded, new post = only that event', async () => {
  const x = await pair(3); const { R, a, aliceId } = x;
  await R.remote.open(aliceId, { force: true }); const s0 = { ...R.remote.stats }; assert.equal(s0.fetches, 1);
  const v = await R.remote.open(aliceId, { force: true }); assert.equal(R.remote.stats.unchanged, 1); assert.equal(R.remote.stats.events_received, s0.events_received, 'unchanged: zero events received'); assert.equal(v.posts.length, 3);
  await a.post('/api/posts', { content: 'fresh delta post' }); const e0 = R.remote.stats.events_received;
  const v2 = await R.remote.open(aliceId, { force: true }); assert.equal(R.remote.stats.events_received - e0, 1, 'only the new event'); assert.ok(v2.posts.some((p) => p.content === 'fresh delta post')); assert.equal(v2.posts.length, 4);
  assert.equal(R.remote.stats.fetches, 1, 'never a full snapshot again');
});
test('delta base only advances over fully verified batches (a rejected event is never skipped by a later delta)', async () => {
  const x = await pair(1); const { R, aliceId } = x; R.remote.forget(aliceId);
  const real = R.peers.call.bind(R.peers); let tamper = true;
  R.peers.call = async (...a) => { const r = await real(...a); if (tamper && r && r.events) r.events.forEach((e) => { if (e.payload && e.payload.content) e.payload.content = 'EVIL'; }); return r; };
  await R.remote.open(aliceId, { force: true }).catch(() => {});
  assert.equal(R.db.get('SELECT snap_seq FROM remote_actors WHERE actor_id=?', aliceId).snap_seq, null, 'no delta base after a rejected event');
  tamper = false; const ok = await R.remote.open(aliceId, { force: true }); assert.equal(ok.posts[0].content, 'alice post 0', 'the genuine event is fetched, not skipped');
});
test('origin rollback is detected: a shorter chain than the verified base drops the derived cache and refetches in full', async () => {
  const x = await pair(2); const { R, aliceId } = x; await R.remote.open(aliceId, { force: true });
  const real = R.peers.call.bind(R.peers); let lied = false;
  R.peers.call = async (peer, m, p, o) => { if (!lied && /after=/.test(p)) { lied = true; return { actor: aliceId, head_seq: 1, events: [], delta: true, has_more: false, through_seq: 1 }; } return real(peer, m, p, o); };
  const v = await R.remote.open(aliceId, { force: true }); assert.equal(R.remote.stats.divergences, 1); assert.equal(v.posts.length, 2, 'rebuilt from a full snapshot');
  assert.equal(R.db.get("SELECT COUNT(*) c FROM integrity_findings WHERE kind='origin_rollback'").c, 1);
});

// ============================================================================================================ GATE 2: deleted stays deleted
test('GATE tombstone: a deleted post never reappears in the discovery cache, even if its delete event was evicted and a stale create is re-delivered', async () => {
  const x = await pair(2); const { S, R, a, aliceId } = x;
  await a.post('/api/posts', { content: 'will be deleted soon' }); const evId = postId(S, 'will be deleted soon'); const created = { id: S.db.get('SELECT id FROM posts WHERE event_id=?', evId).id };
  await R.remote.open(aliceId, { force: true }); assert.ok((await R.remote.open(aliceId)).posts.some((p) => p.content === 'will be deleted soon'));
  const staleCreate = JSON.parse(S.db.get("SELECT body FROM events WHERE event_id=?", evId).body);
  assert.equal((await a.del('/api/posts/' + created.id)).status, 200);
  const v = await R.remote.open(aliceId, { force: true }); assert.ok(!v.posts.some((p) => p.content === 'will be deleted soon'));
  assert.ok(R.remote.tombstone(aliceId, evId), 'durable tombstone recorded');
  R.db.run("DELETE FROM remote_cache WHERE event_type='post.delete'");                       // the delete event is evicted / expired …
  R.remote.cacheEvents([staleCreate]);                                                       // … and a laggy peer re-delivers the old create
  assert.equal(R.db.get('SELECT COUNT(*) c FROM remote_cache WHERE event_id=?', evId).c, 0, 'stale create refused');
  assert.ok(!R.remote.view(aliceId).posts.some((p) => p.content === 'will be deleted soon'), 'not visible');
  assert.ok(R.remote.stats.tombstoned_skips >= 1);
});
test('GATE tombstone (ledger): a post deleted while the replica was offline is deleted after it returns, stays deleted through reindex and stale re-delivery', async () => {
  const x = await pair(1); const { S, R, a, aliceId, peer } = x;
  await a.post('/api/posts', { content: 'delete me later' }); const p = { id: S.db.get("SELECT id FROM posts WHERE content='delete me later'").id }; await x.sync(); const evId = postId(R, 'delete me later'); assert.ok(evId);
  const realT = R.peers.transport; R.peers.transport = { request: async () => { throw new Error('down'); } };
  assert.equal((await a.del('/api/posts/' + p.id)).status, 200); await R.peers.syncPeer(R.peers.get(peer.id));
  assert.equal(R.db.get('SELECT deleted_at FROM posts WHERE event_id=?', evId).deleted_at, null, 'offline replica still shows it');
  R.peers.transport = realT; R.db.run('UPDATE peers SET next_retry_at=0 WHERE id=?', peer.id); await x.sync();
  assert.ok(R.db.get('SELECT deleted_at FROM posts WHERE event_id=?', evId).deleted_at, 'deleted after the peer is back');
  const stale = JSON.parse(S.db.get('SELECT body FROM events WHERE event_id=?', evId).body);
  assert.equal(R.ledger.ingest(stale, { source: 'peer:test' }).status, 'duplicate', 'stale re-delivery is a no-op');
  R.ledger.reindex(); assert.ok(R.db.get('SELECT deleted_at FROM posts WHERE event_id=?', evId).deleted_at, 'full replay keeps it deleted'); assert.equal(R.db.get('SELECT content FROM posts WHERE event_id=?', evId).content, '');
});

// ============================================================================================================ GATE 3: divergence is detected AND repaired
function sup(R, over = {}) { return new HealingSupervisor({ db: R.db, ledger: R.ledger, peers: R.peers, remote: R.remote, cfg: { cycleBudgetMs: 5000, ...over.cfg }, ...over }); }
test('GATE divergence (ledger): a tampered event row is detected, restored from a peer, and the corrupt original is quarantined (never deleted)', async () => {
  const x = await pair(3); const { S, R, aliceId } = x; const H = sup(R);
  const row = R.db.get("SELECT lid, event_id, sequence, body FROM events WHERE body LIKE '%alice post 1%'"); assert.ok(row);
  R.db.run("UPDATE events SET body=replace(body,'alice post 1','EVIL post 1') WHERE lid=?", row.lid);
  assert.ok(R.ledger.verifyAll().problems.length >= 1);
  const rep = await H.cycle(); assert.equal(rep.repaired >= 1, true, JSON.stringify(rep));
  const f = H.findings({ limit: 5 }).find((q) => q.kind === 'event_corrupt'); assert.equal(f.status, 'repaired'); assert.equal(f.severity, 'critical');
  assert.equal(R.ledger.verifyAll().problems.length, 0);
  assert.equal(R.db.get('SELECT COUNT(*) c FROM events_quarantine WHERE reason LIKE ?', 'replaced:%').c, 1); assert.match(R.db.get('SELECT body FROM events_quarantine').body, /EVIL post 1/);
  const ids = (h) => h.ledger.eventsForActor(aliceId, 1, 100).map((e) => e.event_id).join(); assert.equal(ids(R), ids(S), 'identical to the origin again');
  assert.equal(R.db.get('SELECT content FROM posts WHERE event_id=?', row.event_id).content, 'alice post 1', 'derived view rebuilt from the repaired ledger');
});
test('self-healing never gives up silently and never deletes: unrecoverable corruption stays OPEN with back-off, then heals when a peer returns', async () => {
  const x = await pair(2); const { R, peer } = x; const clock = { t: Date.now() }; const H = sup(R, { now: () => clock.t, cfg: { backoffBaseMs: 100, backoffMaxMs: 1000, cycleBudgetMs: 5000 }, rand: () => 1 });
  const row = R.db.get("SELECT lid FROM events WHERE body LIKE '%alice post 0%'"); const original = R.db.get('SELECT body FROM events WHERE lid=?', row.lid).body;
  R.db.run("UPDATE events SET body=replace(body,'alice post 0','EVIL') WHERE lid=?", row.lid);
  const realT = R.peers.transport; R.peers.transport = { request: async () => { throw new Error('down'); } };
  await H.cycle(); let f = H.findings({ status: 'open' }).find((q) => q.kind === 'event_corrupt'); assert.ok(f); assert.equal(f.attempts, 1);
  await H.cycle(); f = H.findings({ status: 'open' }).find((q) => q.kind === 'event_corrupt'); assert.equal(f.attempts, 1, 'back-off: not retried immediately');
  clock.t += 5000; await H.cycle(); f = H.findings({ status: 'open' }).find((q) => q.kind === 'event_corrupt'); assert.equal(f.attempts, 2);
  assert.ok(R.db.get('SELECT body FROM events WHERE lid=?', row.lid).body.includes('EVIL'), 'row untouched while nobody can supply a valid copy');
  R.peers.transport = realT; clock.t += 5000; await H.cycle();
  assert.equal(H.findings({ limit: 10 }).find((q) => q.kind === 'event_corrupt').status, 'repaired'); assert.equal(R.db.get('SELECT body FROM events WHERE lid=?', row.lid).body, original);
});
test('GATE divergence (view): a posts row that disagrees with the ledger is detected and rebuilt by reindex; original events are untouched', async () => {
  const x = await pair(3); const { R } = x; const clock = { t: Date.now() }; const H = sup(R, { now: () => clock.t }); const before = fp(R.db);
  R.db.run("UPDATE posts SET content='TAMPERED' WHERE content='alice post 2'");
  const id = R.db.get("SELECT event_id FROM posts WHERE content='TAMPERED'").event_id;
  await H.cycle(); assert.equal(R.db.get('SELECT content FROM posts WHERE event_id=?', id).content, 'alice post 2');
  assert.equal(fp(R.db), before, 'ledger events unchanged'); assert.equal(H.metrics.guard_violations, 0);
  assert.equal(H.findings({ limit: 5 }).find((q) => q.kind === 'view_diverged').status, 'repaired');
  R.db.run("UPDATE posts SET deleted_at=1, content='' WHERE content='alice post 1'");           // "deleted in view only" is also divergence
  await H.cycle(); assert.equal(R.db.get("SELECT COUNT(*) c FROM posts WHERE content='alice post 1' AND deleted_at IS NULL").c, 0, 'inside the reindex cool-down the finding waits (no reindex storm)');
  clock.t += 2 * 3600000; await H.cycle(); assert.equal(R.db.get("SELECT COUNT(*) c FROM posts WHERE content='alice post 1' AND deleted_at IS NULL").c, 1);
});
test('GATE divergence (cache): corrupt or resurrected discovery-cache rows are found and dropped; the cache is derived so nothing original is lost', async () => {
  const x = await pair(2); const { S, R, aliceId } = x; await R.remote.open(aliceId, { force: true }); const H = sup(R);
  const row = R.db.get("SELECT event_id FROM remote_cache WHERE event_type='post.create' LIMIT 1");
  R.db.run("UPDATE remote_cache SET body=replace(body,'alice post','EVIL') WHERE event_id=?", row.event_id);
  const ghost = S.db.get("SELECT event_id, body FROM events WHERE event_type='post.create' AND body LIKE '%alice post 1%'");
  R.remote._tomb(aliceId, ghost.event_id, 99, Date.now(), Date.now()); const g = JSON.parse(ghost.body);
  R.db.run('INSERT OR REPLACE INTO remote_cache(event_id,actor_id,sequence,event_type,created_at,body,fetched_at) VALUES(?,?,?,?,?,?,?)', g.event_id, aliceId, g.sequence, g.event_type, g.created_at, ghost.body, Date.now());
  await H.cycle(); assert.equal(R.db.get('SELECT COUNT(*) c FROM remote_cache WHERE event_id IN (?,?)', row.event_id, ghost.event_id).c, 0);
  assert.deepEqual(H.findings({ limit: 10 }).filter((f) => f.layer === 'remote_cache').map((f) => f.kind).sort(), ['cache_corrupt', 'resurrected_cache']);
});
test('GATE divergence (anti-entropy): events a restored peer handed out below our cursor are found by comparing heads and fetched exactly', async () => {
  const x = await pair(2); const { S, R, a, aliceId, peer } = x;
  await a.post('/api/posts', { content: 'missed one' }); await a.post('/api/posts', { content: 'missed two' });
  R.db.run('UPDATE peers SET remote_cursor=? WHERE id=?', S.ledger.head().lid, peer.id);      // the cursor now points past events we never received
  const r = await x.sync(); assert.equal(r.accepted, 0, 'plain cursor sync cannot see them');
  const ae = new AntiEntropy({ peers: R.peers, ledger: R.ledger, db: R.db }); x.resetDelivered();
  const out = await ae.maybeRun(R.peers.get(peer.id), { force: true });
  assert.equal(out.missing, 1); assert.equal(out.repaired, 1); assert.ok(postId(R, 'missed two'), 'repaired'); assert.equal(R.db.get('SELECT COUNT(*) c FROM events WHERE actor_id=?', aliceId).c, S.db.get('SELECT COUNT(*) c FROM events WHERE actor_id=?', aliceId).c);
  assert.ok(x.delivered() <= 2 + 1, 'only the missing range was transferred: ' + x.delivered());
  const again = await ae.maybeRun(R.peers.get(peer.id), { force: true }); assert.equal(again.missing, 0, 'second run: in sync');
});
test('anti-entropy runs by itself after a sync that follows a failure (peer back from offline) and repairs a skipped range without any operator action', async () => {
  const x = await pair(2); const { S, R, a, aliceId, peer } = x; R.peers.antiEntropy = x.hookAE;
  await a.post('/api/posts', { content: 'auto repaired one' });
  R.db.run('UPDATE peers SET remote_cursor=?, fail_streak=1, next_retry_at=0 WHERE id=?', S.ledger.head().lid, peer.id);   // cursor skipped past the event, peer "was failing"
  const r = await x.sync(); assert.equal(r.accepted, 0);
  await waitFor(() => !!postId(R, 'auto repaired one'), 6000, 50);
  assert.ok(postId(R, 'auto repaired one')); assert.ok(R.peers.antiEntropy.stats.repaired >= 1);
});
test('anti-entropy: a head that disagrees at the same sequence is recorded; malformed heads and actors outside our scope are ignored', async () => {
  const x = await pair(2); const { R, aliceId, peer } = x; const st = R.ledger.actorState(aliceId);
  const real = R.peers.call.bind(R.peers);
  R.peers.call = async (p, m, path_, o) => /\/heads/.test(path_) ? { heads: [{ actor: aliceId, seq: st.last_seq, id: 'ev1_' + 'f'.repeat(64) }, { actor: 'hub1_' + 'q'.repeat(52), seq: 9, id: 'ev1_' + 'a'.repeat(64) }, { actor: aliceId, seq: -1, id: 'x' }, null, 'junk'], has_more: false, next: null } : real(p, m, path_, o);
  const ae = new AntiEntropy({ peers: R.peers, ledger: R.ledger, db: R.db }); const out = await ae.maybeRun(R.peers.get(peer.id), { force: true });
  assert.equal(out.forks, 1); assert.equal(out.checked, 1); assert.equal(R.db.get("SELECT COUNT(*) c FROM integrity_findings WHERE kind='head_mismatch'").c, 1);
  assert.equal(R.db.get('SELECT last_seq FROM actor_state WHERE actor_id=?', aliceId).last_seq, st.last_seq, 'our chain is untouched');
});

// ============================================================================================================ self-healing infrastructure
test('self-healing: sync gaps that stay open are filled through a healthy peer; stale-gap detection respects its threshold', async () => {
  const x = await pair(2); const { S, R, a, aliceId } = x; const clock = { t: Date.now() }; const H = sup(R, { now: () => clock.t, cfg: { gapStaleMs: 60000 } });
  for (let i = 0; i < 3; i++) await a.post('/api/posts', { content: 'gap fill ' + i });
  const have = R.ledger.actorState(aliceId).last_seq; const evs = S.ledger.eventsForActor(aliceId, have + 1, 10); assert.equal(evs.length, 3);
  assert.equal(R.ledger.ingest(evs[2], { source: 'peer:x' }).status, 'gap');
  await H.cycle(); assert.equal(H.findings({ limit: 5 }).filter((f) => f.kind === 'gap_stale').length, 0, 'fresh gap is left to the normal sync');
  R.db.run('UPDATE ledger_gaps SET detected_at=?', clock.t - 120000); await H.cycle();
  assert.equal(R.db.get('SELECT COUNT(*) c FROM ledger_gaps').c, 0); assert.equal(R.ledger.actorState(aliceId).last_seq, have + 3);
  assert.equal(H.findings({ limit: 5 }).find((f) => f.kind === 'gap_stale').status, 'repaired');
});
test('self-healing: an abusive peer is quarantined (content sync really paused, even for a trusted peer), reversible after the cool-down', async () => {
  const x = await pair(1); const { S, R, a, peer } = x; const clock = { t: Date.now() }; const H = sup(R, { now: () => clock.t, cfg: { quarantineMs: 60000, abuseMinRejected: 10 } });
  await H.cycle(); R.db.run('UPDATE peers SET events_rejected=events_rejected+30, events_received=events_received+4 WHERE id=?', peer.id);
  await H.cycle(); assert.equal(R.peers.syncAllowed(R.peers.get(peer.id)), false, 'paused'); assert.equal(H.findings({ limit: 5 }).find((f) => f.kind === 'peer_abusive').severity, 'critical');
  assert.equal(H.status().state, 'degraded', 'no healthy path left: reported, not hidden'); assert.equal(H.lifecycle(R.peers.get(peer.id)), 'authenticated');
  await a.post('/api/posts', { content: 'sent during quarantine' }); R.db.run('UPDATE peers SET next_retry_at=0 WHERE id=?', peer.id); x.resetDelivered();
  const q = await R.peers.syncPeer(R.peers.get(peer.id)); assert.equal(q.accepted || 0, 0); assert.equal(x.delivered(), 0, 'no content crosses the wire while quarantined'); assert.ok(!postId(R, 'sent during quarantine'));
  clock.t += 61000; await H.cycle(); assert.equal(R.peers.syncAllowed(R.peers.get(peer.id)), true, 'released');
  const r = await x.sync(); assert.equal(r.accepted, 1, 'caught up exactly after release'); assert.ok(postId(R, 'sent during quarantine'));
  R.db.run('UPDATE peers SET events_rejected=events_rejected+2, events_received=events_received+500 WHERE id=?', peer.id); await H.cycle();
  assert.equal(R.peers.syncAllowed(R.peers.get(peer.id)), true, 'a few rejects among many good events is not abuse');
});
test('self-healing: back-off grows with jitter and is capped; the global retry budget prevents storms; cycles never overlap and are time-boxed', async () => {
  const b = new Backoff({ baseMs: 100, maxMs: 1000, rand: () => 1, now: () => 0 }); const d = [1, 2, 3, 4, 5, 6].map(() => b.fail('k')); assert.deepEqual(d, [100, 200, 400, 800, 1000, 1000]);
  const lo = new Backoff({ baseMs: 100, maxMs: 1000, rand: () => 0, now: () => 0 }); assert.equal(lo.fail('k'), 50, 'jitter lower bound');
  let t = 0; const rb = new RetryBudget({ capacity: 5, refillPerMin: 6, now: () => t }); let ok = 0; for (let i = 0; i < 50; i++) if (rb.take()) ok++; assert.equal(ok, 5); t += 60000; ok = 0; for (let i = 0; i < 50; i++) if (rb.take()) ok++; assert.equal(ok, 5, 'refills, never above capacity');
  const x = await pair(1); const { R } = x; const clock = { t: Date.now() }; let heals = 0;
  const H = sup(R, { now: () => clock.t, cfg: { retryCapacity: 4, retryPerMin: 4, maxHealPerCycle: 5, backoffBaseMs: 1 } });
  H.register({ name: 't', layer: 'test', kinds: ['x'], detect: async () => [], heal: async () => { heals++; throw new Error('always failing'); } });
  for (let i = 0; i < 100; i++) R.db.run("INSERT INTO integrity_findings(layer,subject,kind,detail,status,detected_at) VALUES('test',?, 'x','{}','open',?)", 's' + i, 1);
  for (let i = 0; i < 40; i++) { clock.t += 5; await H.cycle(); }
  assert.ok(heals <= 4, 'budget bounds attempts to its capacity within a minute: ' + heals); assert.ok(H.metrics.skipped_budget > 0);
  const slow = sup(R, { cfg: { cycleBudgetMs: 30 } }); let ran = 0; slow.detectors = []; for (let i = 0; i < 5; i++) slow.register({ name: 'd' + i, layer: 'l' + i, kinds: [], detect: async () => { ran++; await new Promise((r) => setTimeout(r, 25)); return []; } });
  const [r1, r2] = await Promise.all([slow.cycle(), slow.cycle()]); assert.equal(r2.skipped, true, 'no overlap'); assert.ok(ran < 5, 'time-boxed: ' + ran);
  for (let i = 0; i < 5; i++) await slow.cycle(); assert.ok(ran >= 5, 'rotation covers every detector over successive cycles');
});
test('self-healing guard: a "derived-only" healer that changes original data is disabled and reported as critical', async () => {
  const x = await pair(2); const { R } = x; const H = sup(R); let calls = 0;
  H.register({ name: 'rogue', layer: 'rogue', kinds: ['k'], guard: true, detect: async () => [{ subject: 'z', kind: 'k' }], heal: async () => { calls++; R.db.run('DELETE FROM events WHERE lid=(SELECT MAX(lid) FROM events)'); return { repaired: true }; } });
  await H.cycle(); assert.equal(calls, 1); assert.equal(H.metrics.guard_violations, 1); assert.equal(H.detectors.find((d) => d.name === 'rogue').disabled, true);
  assert.equal(H.findings({ limit: 10 }).find((f) => f.kind === 'originals_changed').severity, 'critical'); await H.cycle(); assert.equal(calls, 1, 'never runs again');
});
test('peer lifecycle: Discovered → Offline / Authenticated → Syncing → Synced → Degraded; "synced" is never claimed without a real successful sync', async () => {
  const S = await mk(); const R = await mk(); const H = sup(R);
  const p = R.peers.add(S.base, { state: 'trusted' }); R.peers.setPeerSync(p.id, false);
  R.db.run('UPDATE peers SET next_retry_at=? WHERE id=?', Date.now() + 1e9, p.id);
  assert.equal(H.lifecycle(R.peers.get(p.id)), 'discovered');
  R.db.run('UPDATE peers SET fail_streak=1 WHERE id=?', p.id); assert.equal(H.lifecycle(R.peers.get(p.id)), 'offline', 'failed before ever connecting');
  R.db.run('UPDATE peers SET fail_streak=0, last_ok=?, sync_content=0 WHERE id=?', Date.now(), p.id); R.peers.setContentMode('off');
  assert.equal(H.lifecycle(R.peers.get(p.id)), 'authenticated', 'handshake proven, content sync not allowed');
  R.peers.setContentMode('trusted'); R.peers.setPeerSync(p.id, true); R.db.run('UPDATE peers SET last_ok=? WHERE id=?', Date.now(), p.id);
  R.db.run("INSERT INTO ledger_gaps(actor_id,expected_seq,seen_seq,source,detected_at) VALUES('hub1_x',1,5,'t',?)", Date.now()); assert.equal(H.lifecycle(R.peers.get(p.id)), 'syncing'); assert.equal(H.status().state, 'syncing');
  R.db.run('DELETE FROM ledger_gaps'); assert.equal(H.lifecycle(R.peers.get(p.id)), 'synced'); assert.equal(H.status().state, 'synced');
  R.db.run('UPDATE peers SET fail_streak=1 WHERE id=?', p.id); assert.equal(H.lifecycle(R.peers.get(p.id)), 'degraded'); R.db.run('UPDATE peers SET fail_streak=4 WHERE id=?', p.id); assert.equal(H.lifecycle(R.peers.get(p.id)), 'offline'); assert.equal(H.status().state, 'offline');
  assert.equal(sup(R, { peers: { list: () => [], inflight: new Set(), syncAllowed: () => false } }).status().state, 'standalone');
});
test('API: /api/admin/healing is owner-only (Developer Diagnostics), runs a bounded cycle on demand and exposes no secrets', async () => {
  const x = await pair(2); const { R } = x; const owner = new Client(R.base); await owner.login('carol', PW);
  const r = await owner.get('/api/admin/healing'); assert.equal(r.status, 200); assert.ok(['synced', 'syncing', 'standalone', 'degraded', 'offline'].includes(r.json.state)); assert.ok(Array.isArray(r.json.detectors) && r.json.detectors.length >= 6);
  const run = await owner.post('/api/admin/healing/run', {}); assert.equal(run.status, 200); assert.ok(run.json.cycle && run.json.status);
  const bob = new Client(R.base); assert.equal((await bob.post('/api/register', { username: 'bob', password: PW })).status < 300, true); await bob.login('bob', PW);
  assert.equal((await bob.get('/api/admin/healing')).status, 403); assert.equal((await new Client(R.base).get('/api/admin/healing')).status, 401);
  assert.ok(!JSON.stringify(r.json).includes('"body"'), 'findings expose metadata only, never event bodies');
});

// ============================================================================================================ content on demand: persistence, replicas, refresh
const C = require('../src/net/p2p/index-crypto');
const { DistributedIndex } = require('../src/net/p2p/distributed-index');
const { SearchService, FederatedSearch } = require('../src/net/p2p/federated-search');
const { PostIndexer, createContentProvider } = require('../src/net/p2p/post-indexer');
const { LoopbackNetwork } = require('../src/net/p2p/index-governor');
const { verifyEnvelope } = require('../src/ledger');
const trustAll = { stateOf: () => 'TRUSTED', allow: () => ({ ok: true }), observe() {} };

async function contentWorld() {
  const net = new LoopbackNetwork(); const S = await mk(); const X = await mk(); const R = await mk();
  const a = new Client(S.base); await a.setup('alice', PW); const aliceId = (await a.get('/api/me')).json.user.account_id;
  const node = (hub, replica) => {
    const signer = C.createEd25519Signer(); const index = new DistributedIndex({ db: hub.db, localPeerId: () => signer.peerId });
    const service = new SearchService({ index, signer, selfId: signer.peerId, trust: trustAll, config: { rateBurst: 1e6, ratePerSec: 1e6 },
      ...(replica ? { replicaProvider: (id) => hub.remote.cachedPost(id) } : { contentProvider: createContentProvider({ db: hub.db }), isStillPublic: (id) => ixr.isStillPublic(id) }) });
    const transport = net.attach(signer.peerId); const n = { id: signer.peerId, signer, index, service, transport, hub };
    var ixr = new PostIndexer({ db: hub.db, index, selfId: signer.peerId, region: 'JP' }); n.indexer = ixr; return n;
  };
  const s = node(S, false), x = node(X, true), r = node(R, false);
  for (const n of [s, x]) await n.transport.start((f, m) => n.service.handle(f, m));
  const peers = [{ peer_id: s.id, region: 'JP', languages: ['ja'] }, { peer_id: x.id, region: 'DE', languages: ['en'] }];
  const fed = (extra = {}) => new FederatedSearch({ index: r.index, transport: r.transport, signer: r.signer, selfId: r.id, trust: trustAll, profile: { region: 'VN', languages: ['vi'] }, peers: () => peers,
    contentStore: R.remote, verifyEvents: (evs) => R.remote.cacheEvents(evs), config: { stageTimeoutMs: 800, totalTimeoutMs: 4000, ...extra } });
  const give = (hub, id) => hub.remote.cacheEvents([JSON.parse(S.db.get("SELECT body FROM events WHERE event_id=? AND event_type='post.create'", id).body)]);
  return { net, S, X, R, a, aliceId, s, x, r, fed, give, ttl: 600000 };
}
const post = async (w, text) => { await w.a.post('/api/posts', { content: text }); return postId(w.S, text); };

test('CONTENT persistence: a verified post survives a restart of the search layer (read back from the durable cache, zero network)', async () => {
  const w = await contentWorld(); const id = await post(w, 'persist me please'); const f1 = w.fed();
  const r1 = await f1.fetchContent({ origin_ref: w.s.id, content_id: id }); assert.equal(r1.status, 'ok'); assert.equal(r1.post.content, 'persist me please');
  w.net.log.length = 0; const f2 = w.fed();                                              // "restart": brand-new in-memory state, same database
  const r2 = await f2.fetchContent({ origin_ref: w.s.id, content_id: id }); assert.equal(r2.status, 'ok'); assert.equal(r2.cached, true); assert.equal(w.net.log.length, 0);
  assert.equal(f2.metrics.content_requests, 0);
});
test('GATE replica failover: origin offline → a valid replica serves the signed events; tampered replicas are rejected; a tombstone beats any replica', async () => {
  const w = await contentWorld(); const id = await post(w, 'replicated story'); w.give(w.X, id); const key = w.s.id + '\t' + id;
  const f = w.fed(); f._holders.set(key, new Set([w.x.id])); w.net.setDown(w.s.id);
  const ok = await f.fetchContent({ origin_ref: w.s.id, content_id: id }); assert.equal(ok.status, 'ok'); assert.equal(ok.from_replica, true); assert.equal(ok.may_be_stale, true); assert.equal(ok.post.content, 'replicated story');
  // tampered replica
  const id2 = await post(w, 'tamper target'); w.give(w.X, id2); w.X.db.run("UPDATE remote_cache SET body=replace(body,'tamper target','FORGED TEXT') WHERE event_id=?", id2);
  const f2 = w.fed(); f2._holders.set(w.s.id + '\t' + id2, new Set([w.x.id])); const bad = await f2.fetchContent({ origin_ref: w.s.id, content_id: id2 });
  assert.equal(bad.status, 'origin_offline'); assert.ok(!JSON.stringify(bad).includes('FORGED'));
  // we already know the post was deleted: no replica can resurrect it
  const id3 = await post(w, 'deleted elsewhere'); w.give(w.X, id3); w.R.remote._tomb(w.aliceId, id3, 999, Date.now(), Date.now());
  const f3 = w.fed(); f3._holders.set(w.s.id + '\t' + id3, new Set([w.x.id])); assert.equal((await f3.fetchContent({ origin_ref: w.s.id, content_id: id3 })).status, 'gone');
  // a replica never serves replies/reposts or tombstoned posts onward
  w.X.remote._tomb(w.aliceId, id, 999, Date.now(), Date.now()); assert.equal(w.X.remote.cachedPost(id), null, 'a tombstoned post is purged and never served onward'); assert.equal(w.X.remote.tombstonedPost(id), true);
  w.net.setDown(w.s.id, false); w.net.setDown(w.x.id); const f4 = w.fed(); f4._holders.set(key, new Set([w.x.id])); assert.equal((await f4.fetchContent({ origin_ref: w.s.id, content_id: id })).status, 'ok', 'origin is preferred when it is up');
});
test('GATE replica failover (end to end): search learns who holds a document; when the origin dies the same result still opens from a replica', async () => {
  const w = await contentWorld(); const id = await post(w, 'tokyo meetup announcement'); w.s.indexer.syncAll();
  const doc = w.s.index.getDocument(w.s.id, id); const sig = (await w.s.service._finish([{ ...doc, text: doc.body, topics: JSON.parse(doc.topics) }], 1)).items[0].origin_sig;
  w.x.index.upsertDocument({ ...doc, text: doc.body, visibility: 'public', topics: JSON.parse(doc.topics) }, { verified: true, originSig: sig }); w.give(w.X, id);
  const f = w.fed(); const snap = await f.search({ q: 'tokyo meetup', scope: 'global' }); const it = snap.items.find((i) => i.content_id === id);
  assert.ok(it); assert.equal(it.sources, 2, 'served by the origin and a replica'); assert.ok(f._holders.get(w.s.id + '\t' + id).has(w.x.id));
  w.net.setDown(w.s.id); const open = await f.fetchContent({ origin_ref: it.origin_ref, content_id: id, content_hash: it.content_hash });
  assert.equal(open.status, 'ok'); assert.equal(open.from_replica, true);
});
test('GATE refresh: stale cache entries are revalidated by hash — unchanged downloads nothing, edits are picked up, deletes purge and leave a tombstone', async () => {
  const w = await contentWorld(); const id = await post(w, 'revalidate me'); const f = w.fed(); const key = w.s.id + '\t' + id;
  await f.fetchContent({ origin_ref: w.s.id, content_id: id }); const ageOut = () => { f._content.get(key).at -= w.ttl; };
  ageOut(); w.net.log.length = 0; let rv = await f.revalidate(); assert.equal(rv.unchanged, 1); assert.equal(f.metrics.content_unchanged, 1); assert.equal(w.net.log.filter((m) => m.t === 'content').length, 1, 'one tiny request, no body');
  w.S.ledger.publish(w.aliceId, 'post.edit', { content: 'revalidate me (edited)' }, { target: id }); ageOut();
  rv = await f.revalidate(); assert.equal(rv.updated, 1); assert.equal(f._content.get(key).post.content, 'revalidate me (edited)');
  assert.equal(f._content.get(key).at <= f.now(), true); const fresh = await f.revalidate(); assert.equal(fresh.checked, 0, 'fresh entries are left alone');
  w.S.ledger.publish(w.aliceId, 'post.delete', {}, { target: id }); ageOut();
  rv = await f.revalidate(); assert.equal(rv.gone, 1); assert.equal(f._content.has(key), false); assert.ok(w.R.remote.tombstone(w.aliceId, id), 'tombstone recorded for the discovery cache');
  assert.equal((await f.fetchContent({ origin_ref: w.s.id, content_id: id })).status, 'gone');
  w.net.setDown(w.s.id); ageOut; assert.equal((await w.fed().fetchContent({ origin_ref: w.s.id, content_id: id })).status, 'gone', 'even offline, a deleted post stays deleted');
});
test('replica provider privacy: only cached PUBLIC posts are ever served onward (never replies/reposts, own private posts, or unknown ids)', async () => {
  const w = await contentWorld(); const id = await post(w, 'public one'); w.give(w.X, id);
  const reply = (await w.a.post('/api/posts', { content: 'a reply', parent: id })).json; const rid = reply && reply.event_id;
  assert.ok(w.X.remote.cachedPost(id).events.length >= 1); assert.equal(w.X.remote.cachedPost('ev1_' + '0'.repeat(64)), null);
  const resp = await w.x.service.handle(w.r.id, { t: 'content', content_id: id, replica_ok: true }); assert.equal(resp.status, 'ok'); assert.equal(resp.replica, true);
  assert.equal((await w.x.service.handle(w.r.id, { t: 'content', content_id: id })).status, 'not_found', 'replica data only on explicit replica_ok');
  assert.equal((await w.x.service.handle(w.r.id, { t: 'content', content_id: 'ev1_' + '1'.repeat(64), replica_ok: true })).status, 'not_found');
  if (rid) { w.give(w.X, rid); assert.equal(w.X.remote.cachedPost(rid), null, 'replies are never served'); }
});

// ============================================================================================================ targeted proofs (added after mutation testing)
test('view-level tombstone: a cached create that slipped in without going through the store is still hidden', async () => {
  const x = await pair(2); const { S, R, aliceId } = x; await R.remote.open(aliceId, { force: true });
  const row = S.db.get("SELECT event_id, body FROM events WHERE event_type='post.create' AND body LIKE '%alice post 1%'"); const ev = JSON.parse(row.body);
  R.remote._tomb(aliceId, row.event_id, 999, Date.now(), Date.now());
  R.db.run('INSERT OR REPLACE INTO remote_cache(event_id,actor_id,sequence,event_type,created_at,body,fetched_at) VALUES(?,?,?,?,?,?,?)', ev.event_id, aliceId, ev.sequence, ev.event_type, ev.created_at, row.body, Date.now());
  assert.ok(!R.remote.view(aliceId).posts.some((p) => p.content === 'alice post 1'));
});
test('event repair only accepts a replacement that verifies and fits our chain: forged copies are refused, the row stays untouched, nothing is lost', async () => {
  const x = await pair(3); const { R, aliceId } = x; const H = sup(R);
  const row = R.db.get("SELECT lid, body FROM events WHERE body LIKE '%alice post 1%'"); R.db.run("UPDATE events SET body=replace(body,'alice post 1','EVIL') WHERE lid=?", row.lid); const corrupt = R.db.get('SELECT body FROM events WHERE lid=?', row.lid).body;
  const real = R.peers.call.bind(R.peers);
  R.peers.call = async (...a) => { const r = await real(...a); if (r && Array.isArray(r.events)) r.events.forEach((e) => { if (e.payload && e.payload.content) e.payload.content = 'FORGED REPLACEMENT'; }); return r; };
  await H.cycle(); const f = H.findings({ limit: 10 }).find((q) => q.kind === 'event_corrupt'); assert.equal(f.status, 'open'); assert.equal(f.attempts, 1);
  assert.equal(R.db.get('SELECT body FROM events WHERE lid=?', row.lid).body, corrupt, 'row unchanged'); assert.equal(R.db.get('SELECT COUNT(*) c FROM events_quarantine').c, 0);
});
test('audit detects a broken chain (a missing predecessor), reports it as critical, and loses nothing', async () => {
  const x = await pair(4); const { R, aliceId } = x; const H = sup(R); const n = R.db.get('SELECT COUNT(*) c FROM events').c;
  const victim = R.db.get('SELECT lid FROM events WHERE actor_id=? AND sequence=3', aliceId); R.db.run('UPDATE events SET actor_id=? WHERE lid=?', 'hub1_' + 'z'.repeat(52), victim.lid);   // seq 3 "disappears" from alice's chain
  await H.cycle(); const f = H.findings({ limit: 20 }).filter((q) => q.kind === 'event_corrupt');
  assert.ok(f.some((q) => q.detail.problem === 'chain_broken' && q.severity === 'critical'), JSON.stringify(f.map((q) => q.detail.problem)));
  assert.equal(R.db.get('SELECT COUNT(*) c FROM events').c, n, 'no event deleted by the healer');
});
test('content acceptance: a deleted post is refused even when handed straight to _accept, and a holder that does not declare itself a replica is ignored', async () => {
  const w = await contentWorld(); const id = await post(w, 'handled directly'); w.give(w.X, id); const f = w.fed(); const key = w.s.id + '\t' + id;
  const evs = JSON.parse(JSON.stringify(w.X.remote.cachedPost(id).events));
  w.R.remote._tomb(w.aliceId, id, 999, Date.now(), Date.now()); assert.equal(f._accept(key, id, evs, '', { from_replica: true }).status, 'gone');
  const id2 = await post(w, 'no replica flag'); const evs2 = [JSON.parse(w.S.db.get("SELECT body FROM events WHERE event_id=?", id2).body)];
  w.x.service.handle = async () => ({ ok: true, status: 'ok', events: evs2 });          // a holder answering like an origin, without declaring replica:true
  await w.x.transport.start((from, m) => w.x.service.handle(from, m)); w.net.setDown(w.s.id);
  const f2 = w.fed(); f2._holders.set(w.s.id + '\t' + id2, new Set([w.x.id])); assert.equal((await f2.fetchContent({ origin_ref: w.s.id, content_id: id2 })).status, 'origin_offline');
});

test('GATE divergence (search index): corrupt, outdated and stale index documents are detected and repaired from the posts; private posts leave the index', async () => {
  const R = await mk(); const c = new Client(R.base); await c.setup('carol', PW);
  const index = new DistributedIndex({ db: R.db, localPeerId: () => 'LOCALPEERID' });
  const indexer = new PostIndexer({ db: R.db, index, selfId: 'LOCALPEERID', region: 'VN' });
  for (const t of ['index alpha text', 'index beta text', 'index gamma text']) await c.post('/api/posts', { content: t });
  indexer.syncAll(); assert.equal(index.stats().documents, 3);
  const H = new HealingSupervisor({ db: R.db, ledger: R.ledger, peers: R.peers, remote: R.remote, indexer, cfg: { cycleBudgetMs: 5000 } });
  const ev = (t) => postId(R, t) || R.db.get('SELECT event_id FROM posts WHERE content=?', t).event_id;
  R.db.run("UPDATE p2p_index_documents SET body='CORRUPTED BODY' WHERE content_id=?", ev('index alpha text'));                      // hash no longer matches
  const stale = 'index beta OLD text'; R.db.run('UPDATE p2p_index_documents SET body=?, content_hash=? WHERE content_id=?', stale, require('crypto').createHash('sha256').update('\n' + stale).digest('hex'), ev('index beta text'));   // internally consistent but behind the post
  const gid = R.db.get("SELECT id FROM posts WHERE content='index gamma text'").id; assert.equal((await c.del('/api/posts/' + gid)).status, 200);                           // deleted; the indexer has not swept yet
  await H.cycle();
  const kinds = H.findings({ limit: 20 }).filter((f) => f.layer === 'index').map((f) => f.kind).sort(); assert.deepEqual(kinds, ['corrupt_doc', 'outdated_doc', 'stale_doc']);
  assert.ok(H.findings({ limit: 20 }).filter((f) => f.layer === 'index').every((f) => f.status === 'repaired'));
  assert.equal(R.db.get("SELECT COUNT(*) c FROM p2p_index_documents WHERE body='index gamma text'").c, 0, 'deleted post removed from the index');
  assert.equal(index.getDocument('LOCALPEERID', ev('index alpha text')).body, 'index alpha text');
  assert.equal(index.getDocument('LOCALPEERID', ev('index beta text')).body, 'index beta text', 'outdated document rebuilt from the post');
});
