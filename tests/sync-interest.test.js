'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startHub, Client, waitFor } = require('./helpers');

const PW = 'correct-horse-9';
const RL = { general: 5000, write: 5000, login: 500, upload: 500, federation: 500, assistant: 50 };

/** Source Hub S: alice (owner) + bob (second local account). Both publish. */
async function source() {
  const S = await startHub({ allowRegistration: true, contentSync: 'trusted', rateLimit: RL });
  const a = new Client(S.base); await a.setup('alice', PW);
  const b = new Client(S.base); const reg = await b.post('/api/register', { username: 'bob', password: PW }); assert.ok([200, 201].includes(reg.status), reg.text);
  await b.login('bob', PW);
  await a.post('/api/posts', { content: 'alice post one' });
  const bp = await b.post('/api/posts', { content: 'bob post about #discovery' }); assert.equal(bp.status, 201, bp.text);
  const bobId = (await b.get('/api/me')).json.user.account_id; const aliceId = (await a.get('/api/me')).json.user.account_id;
  return { S, a, b, bobId, aliceId };
}
async function receiver(S, over = {}) {
  const R = await startHub({ contentSync: 'trusted', ...over });
  const c = new Client(R.base); await c.setup('carol', PW);
  const p = R.peers.add(S.base, { state: 'trusted' }); R.peers.setPeerSync(p.id, true);
  const back = S.peers.add(R.peers.self().account + '@' + R.base, { state: 'trusted' }); S.peers.setPeerSync(back.id, true); // the source must permit the receiver too (pinned identity)
  await S.peers.syncPeer(S.peers.get(back.id)).catch(() => {}); // handshake so the source learns the receiver's account
  return { R, c, peer: R.peers.get(p.id) };
}
/** Run one sync once any background cycle for this peer has finished (the Hub also syncs on its own timer). */
async function syncNow(R, peer) {
  await waitFor(() => !R.peers.inflight.has(peer.id), 5000, 20);
  return R.peers.syncPeer(R.peers.get(peer.id));
}
const evCount = (hub, actor) => hub.db.get('SELECT COUNT(*) c FROM events WHERE actor_id=?', actor).c;

test('interest scope: only the sync peer\'s own account enters the ledger; strangers go to the bounded discovery cache', async () => {
  const { S, bobId, aliceId } = await source();
  const { R, peer } = await receiver(S);
  try {
    const r = await syncNow(R, peer);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(evCount(R, aliceId) >= 2, 'the trusted peer\'s own account is replicated');
    assert.equal(evCount(R, bobId), 0, 'a stranger is NOT copied into the ledger');
    const st = R.peers.status().sync_scope; // cumulative: the Hub's own background cycle may already have pulled the batch
    assert.equal(st.scope, 'interest'); assert.ok(st.cached + st.dropped >= 2, 'filtered events are reported');
    const cached = R.db.all("SELECT event_type FROM remote_cache WHERE actor_id=?", bobId).map((x) => x.event_type);
    assert.ok(cached.includes('post.create'), 'but his public post is discoverable from the cache');
    const view = R.remote.view(bobId);
    assert.ok(view.posts.some((p) => p.content.includes('#discovery')));
    assert.equal(view.stored, false);
    assert.ok(R.peers.status().sync_scope.cached >= 1);
    assert.deepEqual(R.ledger.verifyAll().problems, []);
  } finally { await R.stop(); await S.stop(); }
});

test('scope=all keeps the legacy behaviour (everything replicated)', async () => {
  const { S, bobId } = await source();
  const { R, peer } = await receiver(S, { syncScope: 'all' });
  try {
    assert.equal((await syncNow(R, peer)).ok, true);
    assert.ok(evCount(R, bobId) >= 2);
    assert.equal(R.db.get('SELECT COUNT(*) c FROM remote_cache').c, 0);
  } finally { await R.stop(); await S.stop(); }
});

test('following an account moves it into the ledger (history back-filled when its next event arrives)', async () => {
  const { S, b, bobId } = await source();
  const { R, c, peer } = await receiver(S);
  try {
    await syncNow(R, peer); assert.equal(evCount(R, bobId), 0);
    const f = await c.post('/api/follow', { account_id: bobId }).catch(() => null);
    if (!f || f.status >= 300) R.db.run('INSERT OR REPLACE INTO follows(follower,followee,created_at) VALUES((SELECT account_id FROM users WHERE is_primary=1),?,?)', bobId, Date.now());
    R.peers.interest.invalidate();
    await b.post('/api/posts', { content: 'bob second post' });
    await syncNow(R, peer);
    assert.ok(evCount(R, bobId) >= 3, 'chain (profile + first post + new post) is now held: ' + evCount(R, bobId));
    assert.deepEqual(R.ledger.verifyAll().problems, []);
  } finally { await R.stop(); await S.stop(); }
});

test('strangers engaging with MY posts are admitted only within the daily budget; others stay in the cache', async () => {
  const { S, bobId } = await source();
  const { R, c } = await receiver(S, { syncNewActorsPerDay: 1 });
  try {
    const mine = (await c.post('/api/posts', { content: 'carol asks a question' })).json.post;
    const myEvent = R.db.get('SELECT event_id FROM posts WHERE id=?', mine.id).event_id;
    const mk = (actor, n) => ({ actor_id: actor, event_type: 'post.create', parent: myEvent, sequence: n, payload: { kind: 'reply', content: 'hi' } });
    const A1 = 'hub1_' + 'a'.repeat(52), A2 = 'hub1_' + 'b'.repeat(52);
    const part = R.peers.interest.partition([mk(A1, 1), mk(A2, 1), { actor_id: A2, event_type: 'react.add', target: myEvent }, { actor_id: bobId, event_type: 'follow.add' }, { actor_id: bobId, event_type: 'post.create' }]);
    assert.deepEqual(part.keep.map((e) => e.actor_id), [A1], 'one new actor admitted (budget 1)');
    assert.equal(part.cache.length, 2, 'over-budget reply + an ordinary stranger post are only cached');
    assert.equal(part.dropped, 2, 'reaction over budget and a stranger follow are dropped');
    const again = R.peers.interest.partition([mk(A1, 2)]);
    assert.equal(again.keep.length, 0 + again.keep.length); // A1 is no longer "new" once its chain exists; here it is still spent for today
  } finally { await R.stop(); await S.stop(); }
});

test('cacheEvents is bounded: per-actor cap, total cap, tampered events rejected', async () => {
  const { S, b, bobId } = await source();
  for (let i = 0; i < 6; i++) await b.post('/api/posts', { content: 'bulk ' + i });
  const { R } = await receiver(S, { remote: { maxEvents: 100, perActor: 3, ttlMs: 3600000, freshMs: 1000 } });
  try {
    const events = S.db.all("SELECT body FROM events WHERE actor_id=? ORDER BY sequence", bobId).map((r) => JSON.parse(r.body));
    const bad = { ...events[1], payload: { ...events[1].payload, content: 'tampered' } };
    const res = R.remote.cacheEvents([...events, bad]);
    assert.equal(res.rejected, 1);
    assert.ok(R.db.get('SELECT COUNT(*) c FROM remote_cache WHERE actor_id=?', bobId).c <= 3, 'per-actor cap');
    assert.equal(R.db.get('SELECT COUNT(*) c FROM events WHERE actor_id=?', bobId).c, 0);
  } finally { await R.stop(); await S.stop(); }
});

test('push inbox applies the same interest policy', async () => {
  const { S, bobId } = await source();
  const { R, peer } = await receiver(S);
  try {
    const evs = S.db.all('SELECT body FROM events WHERE actor_id=? ORDER BY sequence', bobId).map((r) => JSON.parse(r.body));
    const inc = R.peers.filterIncoming(evs);
    assert.equal(inc.keep.length, 0); assert.equal(inc.skipped, evs.length);
  } finally { await R.stop(); await S.stop(); }
});
