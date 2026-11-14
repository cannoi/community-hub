'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { presenceCfg, startSeed, mkHub, startHub, Client, waitFor, tmp, PNG, formWith, SpyTransport } = require('./helpers');
const { Keystore } = require('../../src/keystore');
const { buildRecord, buildHeartbeat } = require('../../src/presence/record');

const stopAll = (...xs) => Promise.all(xs.filter(Boolean).map((x) => x.stop()));
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('P1 no seed configured → local-only, zero outbound traffic, no onboarding step', async () => {
  const t0 = Date.now(); let hub;
  try {
    hub = await mkHub('alice');
    assert.ok(Date.now() - t0 < 3000, 'boots fast');
    const st = (await hub.owner.get('/api/presence/status')).json;
    assert.equal(st.state, 'local'); assert.equal(st.reason, 'no_seed'); assert.equal(st.seeds_total, 0);
    const sess = (await hub.owner.get('/api/session')).json;
    assert.equal(sess.network_setup_required, false, 'no mandatory "connect to a Hub" step');
    await hub.owner.post('/api/posts', { content: 'local post works' });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(hub.spy.calls.length, 0, 'nothing leaves the machine: ' + hub.spy.calls.join(','));
    assert.equal((await hub.owner.get('/api/presence/search?q=bob')).status, 503);
    assert.equal((await hub.owner.get('/api/feed/home')).json.items.length, 1);
  } finally { await stopAll(hub); }
});

test('P2 a dead seed never blocks boot or local use; failures back off', async () => {
  let hub; const t0 = Date.now();
  try {
    hub = await mkHub('alice', { seeds: ['http://127.0.0.1:1'] });
    assert.ok(Date.now() - t0 < 3000);
    assert.equal((await hub.owner.post('/api/posts', { content: 'works offline from the seed' })).status, 201);
    const st = await waitFor(async () => { const s = (await hub.owner.get('/api/presence/status')).json; return s.state === 'error' && s; }, 8000);
    assert.equal(st.reason, 'seed_unreachable'); assert.equal(st.listed, false);
    const sd = [...hub.presence.states.values()][0];
    assert.ok(sd.fail_streak >= 1 && sd.next_at > Date.now() - 100, 'backoff scheduled');
    assert.ok(!JSON.stringify(st).includes('127.0.0.1'), 'status never reveals seed addresses');
  } finally { await stopAll(hub); }
});

test('P3 zero-config: hubs register themselves, heartbeat, and people are found through the directory', async () => {
  const seed = await startSeed(); let A, B;
  try {
    A = await mkHub('alice', { seeds: [seed.base], display: 'Alice Nguyen' });
    B = await mkHub('bob', { seeds: [seed.base], display: 'Bob Tran' });
    await waitFor(() => seed.directory.has(A.account) && seed.directory.has(B.account), 8000);
    const sa = await waitFor(async () => { const s = (await A.owner.get('/api/presence/status')).json; return s.state === 'network' && s; }, 5000);
    assert.equal(sa.listed, true); assert.equal(sa.endpoint_known, true);
    const hb1 = seed.db.get('SELECT last_seen FROM presence_directory WHERE account_id=?', A.account).last_seen;
    await waitFor(() => seed.db.get('SELECT last_seen FROM presence_directory WHERE account_id=?', A.account).last_seen > hb1, 6000); // heartbeat advances
    const found = (await B.owner.get('/api/presence/search?q=alice')).json.items;
    assert.equal(found.length, 1); assert.equal(found[0].account_id, A.account); assert.equal(found[0].online, true); assert.equal(found[0].reachable, true);
    const res = (await B.owner.get('/api/presence/resolve?account=' + A.account)).json;
    assert.equal(res.name, 'Alice Nguyen');
    const blob = JSON.stringify([found, res]);
    assert.ok(!blob.includes(A.base) && !blob.includes('127.0.0.1') && !/endpoint|pub|token|password/i.test(blob), 'no address/keys in UI-facing directory results');
    // pasting an account id resolves directly
    assert.equal((await B.owner.get('/api/presence/search?q=' + A.account)).json.items[0].account_id, A.account);
    // unknown id
    assert.equal((await B.owner.get('/api/presence/resolve?account=hub1_' + 'a'.repeat(52))).status, 404);
  } finally { await stopAll(A, B, seed); }
});

test('P4 seed protocol: signatures, replay, skew, size, private endpoints, bounds, rate limits, opt-out', async () => {
  const seed = await startSeed({ allowPrivatePeers: false, presence: presenceCfg({ maxEntries: 5 }), rateLimit: { general: 10000, write: 1000, login: 100, upload: 100, federation: 100, assistant: 20, presence: 10000 } });
  const ks = new Keystore(tmp('ksx')); const me = ks.generate(); const now = Date.now();
  const rec = (o = {}, k = ks, acct = me.accountId) => buildRecord(k, { account: acct, name: 'Carol', searchable: true, ...o }, o.ts || Date.now());
  try {
    let r = await post(seed.base, '/presence/v1/register', rec({ endpoint: 'https://example.com' })); assert.equal(r.status, 200);
    r = await post(seed.base, '/presence/v1/register', rec({ endpoint: 'https://example.com', ts: now - 10 })); assert.equal(r.status, 409, 'replay/older ts refused');
    const good = rec({ endpoint: 'https://example.com', ts: Date.now() + 5 });
    assert.equal((await post(seed.base, '/presence/v1/register', { ...good, name: 'Mallory' })).status, 401, 'tampered record');
    assert.equal((await post(seed.base, '/presence/v1/register', { ...good, extra: 1 })).status, 400, 'unknown field');
    const other = ks.generate();
    assert.equal((await post(seed.base, '/presence/v1/register', { ...good, account_id: other.accountId })).status, 401, 'account/pub mismatch');
    assert.equal((await post(seed.base, '/presence/v1/register', rec({ ts: Date.now() - 3600000 }))).status, 400, 'clock skew');
    // private / loopback endpoints are refused on a public seed
    for (const bad of ['http://127.0.0.1:9', 'http://10.0.0.5', 'http://localhost', 'file:///etc/passwd']) {
      const k2 = new Keystore(tmp('ks2')); const a2 = k2.generate();
      const rr = await post(seed.base, '/presence/v1/register', (() => { const x = buildRecord(k2, { account: a2.accountId, name: 'x', searchable: true }, Date.now()); x.endpoint = bad; return x; })());
      assert.ok([400, 401].includes(rr.status), bad + ' -> ' + rr.status);
    }
    // oversize body
    assert.equal((await post(seed.base, '/presence/v1/register', { ...good, name: 'x'.repeat(5000) })).status, 413);
    // heartbeat: needs prior registration and a valid signature
    assert.equal((await post(seed.base, '/presence/v1/heartbeat', buildHeartbeat(ks, other.accountId, Date.now()))).status, 404);
    assert.equal((await post(seed.base, '/presence/v1/heartbeat', buildHeartbeat(ks, me.accountId, Date.now() + 10))).status, 200);
    const evil = new Keystore(tmp('ks3')); const ev = evil.generate();
    assert.equal((await post(seed.base, '/presence/v1/heartbeat', { ...buildHeartbeat(evil, ev.accountId, Date.now()), account_id: me.accountId })).status, 401);
    // opt-out of search keeps resolve-by-id
    const k4 = new Keystore(tmp('ks4')); const a4 = k4.generate();
    await post(seed.base, '/presence/v1/register', buildRecord(k4, { account: a4.accountId, name: 'Hidden Person', searchable: false }, Date.now()));
    assert.deepEqual((await (await fetch(seed.base + '/presence/v1/search?q=hidden')).json()).items, []);
    assert.equal((await fetch(seed.base + '/presence/v1/resolve?account=' + a4.accountId)).status, 200);
    // bounded directory
    for (let i = 0; i < 8; i++) { const k = new Keystore(tmp('ksb')); const a = k.generate(); await post(seed.base, '/presence/v1/register', buildRecord(k, { account: a.accountId, name: 'Bulk ' + i, searchable: true }, Date.now())); }
    assert.ok(seed.directory.count() <= 5, 'entries ≤ maxEntries: ' + seed.directory.count());
    // search needs 2+ chars and escapes wildcards
    assert.equal((await fetch(seed.base + '/presence/v1/search?q=a')).status, 400);
    assert.deepEqual((await (await fetch(seed.base + '/presence/v1/search?q=%25%25')).json()).items, []);
    // withdraw
    const wd = { v: 1, account_id: me.accountId, ts: Date.now() + 100 }; const { buildWithdraw } = require('../../src/presence/record');
    assert.equal((await post(seed.base, '/presence/v1/withdraw', buildWithdraw(ks, me.accountId, Date.now() + 100))).status, 200);
    assert.equal(seed.directory.has(me.accountId), false);
  } finally { await seed.stop(); }
});

test('P4b seed rate limits (per account register, per IP new identities) and body limits', async () => {
  const seed = await startSeed({ rateLimit: { general: 10000, write: 1000, login: 100, upload: 100, federation: 100, assistant: 20, presence: 10000 } });
  try {
    const ks = new Keystore(tmp('ksr')); const me = ks.generate(); let last = 0;
    for (let i = 0; i < 10; i++) last = (await post(seed.base, '/presence/v1/register', buildRecord(ks, { account: me.accountId, name: 'R', searchable: true }, Date.now() + i))).status;
    assert.equal(last, 429, 'per-account register limit');
    let st = 0; for (let i = 0; i < 40; i++) { const k = new Keystore(tmp('ksn')); const a = k.generate(); st = (await post(seed.base, '/presence/v1/register', buildRecord(k, { account: a.accountId, name: 'N' + i, searchable: true }, Date.now()))).status; if (st === 429) break; }
    assert.equal(st, 429, 'per-IP new-identity limit');
  } finally { await seed.stop(); }
});

test('P4c the stand-alone seed serves NO content: no feed, media, federation, API or UI', async () => {
  const seed = await startSeed();
  try {
    for (const p of ['/federation/v1/events?cursor=0', '/federation/v1/inbox', '/media/' + 'a'.repeat(64), '/uploads/x', '/api/feed/public', '/api/session', '/', '/index.html', '/federation/v1/hello?nonce=' + 'n'.repeat(20)]) {
      const r = await fetch(seed.base + p); assert.ok([404, 405].includes(r.status), p + ' -> ' + r.status);
    }
    assert.equal((await fetch(seed.base + '/presence/v1/info')).status, 200);
    assert.equal((await fetch(seed.base + '/health')).status, 200);
  } finally { await seed.stop(); }
});

test('P5 on-demand content: open a profile without any bulk sync; media is streamed, never mirrored', async () => {
  const seed = await startSeed(); let A, B;
  try {
    A = await mkHub('alice', { seeds: [seed.base], display: 'Alice Nguyen' });
    B = await mkHub('bob', { seeds: [seed.base], display: 'Bob Tran' });
    let bulkOnA = 0; const orig = A.ledger.eventsAfter.bind(A.ledger); A.ledger.eventsAfter = (...a) => { bulkOnA++; return orig(...a); };
    let ingestOnB = 0; const oi = B.ledger.ingestBatch.bind(B.ledger); B.ledger.ingestBatch = (...a) => { ingestOnB++; return oi(...a); };
    const up = (await A.owner.req('POST', '/api/media', undefined, { form: formWith(PNG, 'pic.png') })).json;
    await A.owner.post('/api/posts', { content: 'hello network #presence', media: [up.hash] });
    const p2 = (await A.owner.post('/api/posts', { content: 'second post' })).json.post;
    await A.owner.post('/api/posts', { content: 'followers only secret', visibility: 'followers' });
    await waitFor(() => seed.directory.has(A.account), 8000);
    await new Promise((r) => setTimeout(r, 1500)); // plenty of time for any (unwanted) background sync

    assert.equal((await B.owner.get('/api/feed/public')).json.items.length, 0, 'nothing from Alice appears by itself');
    assert.equal(B.db.get('SELECT COUNT(*) c FROM posts').c, 0);
    assert.equal(B.db.get('SELECT COUNT(*) c FROM events WHERE actor_id=?', A.account).c, 0);

    const view = (await B.owner.get('/api/presence/profile/' + A.account)).json;
    assert.equal(view.source, 'live'); assert.equal(view.stored, false);
    assert.equal(view.profile.display_name, 'Alice Nguyen');
    assert.deepEqual(view.posts.map((p) => p.content).sort(), ['hello network #presence', 'second post']);
    assert.ok(!JSON.stringify(view).includes('secret'), 'restricted content is never exposed');
    assert.equal(view.posts.find((p) => p.media.length).media[0].kind, 'image');
    // still nothing in the local ledger / posts after viewing
    assert.equal(B.db.get('SELECT COUNT(*) c FROM posts').c, 0); assert.equal(B.db.get('SELECT COUNT(*) c FROM events WHERE actor_id=?', A.account).c, 0);
    assert.ok(B.db.get('SELECT COUNT(*) c FROM remote_cache').c <= B.cfg.remote.maxEvents);
    // media: only streamed when asked; not mirrored to disk
    assert.equal(B.media.exists(up.hash), false);
    const m = await B.owner.get('/media/' + up.hash, { raw: true });
    assert.equal(m.status, 200); assert.equal(m.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await m.arrayBuffer()), PNG);
    assert.equal(B.media.exists(up.hash), false, 'remote media is not stored locally by default');
    assert.equal(B.db.get('SELECT COUNT(*) c FROM media WHERE hash=?', up.hash).c, 0);
    const rng = await B.owner.get('/media/' + up.hash, { raw: true, headers: { range: 'bytes=0-9' } }); assert.equal(rng.status, 206);
    // proof of "no bulk": no bulk feed / inbox / poke calls were ever made or served
    assert.equal(B.spy.count(/\/federation\/v1\/(events|inbox|poke|peers)/), 0, B.spy.calls.join(' | '));
    assert.equal(bulkOnA, 0); assert.equal(ingestOnB, 0);
    // unauthenticated visitors cannot use it, and unknown media stays private
    assert.equal((await new Client(B.base).get('/api/presence/profile/' + A.account)).status, 401);
    assert.equal((await new Client(B.base).get('/media/' + up.hash, { raw: true })).status, 404, 'anonymous cannot pull through your Hub');
    // edits & deletes (same-actor, signed) are reflected on refresh
    await A.owner.patch('/api/posts/' + p2.id, { content: 'second post (edited)' });
    const gone = (await A.owner.post('/api/posts', { content: 'to delete' })).json.post; await A.owner.del('/api/posts/' + gone.id);
    const v2 = (await B.owner.get('/api/presence/profile/' + A.account + '?refresh=1')).json;
    assert.ok(v2.posts.some((p) => p.content === 'second post (edited)')); assert.ok(!v2.posts.some((p) => p.content === 'to delete'));
    // contacts are not trusted peers and are hidden from the peer list
    assert.equal((await B.owner.get('/api/peers')).json.items.length, 0);
    assert.ok((await B.owner.get('/api/sync/status')).json.contacts >= 1);
  } finally { await stopAll(A, B, seed); }
});

test('P5b tampered snapshots are rejected; offline origin falls back to a stale cache', async () => {
  const seed = await startSeed(); let A, B;
  try {
    A = await mkHub('alice', { seeds: [seed.base] }); B = await mkHub('bob', { seeds: [seed.base] });
    await A.owner.post('/api/posts', { content: 'genuine' }); await waitFor(() => seed.directory.has(A.account), 8000);
    const real = B.peers.call.bind(B.peers);
    B.peers.call = async (...a) => { const r = await real(...a); r.events.forEach((e) => { if (e.payload && e.payload.content) e.payload.content = 'EVIL ' + e.payload.content; }); return r; };
    await assert.rejects(() => B.remote.open(A.account, { force: true }).then((v) => { if (v.posts.length) throw new Error('tampered content shown'); return v; }).then(() => { throw new Error('no profile expected'); }), /no profile expected|tampered/);
    assert.equal(B.db.get("SELECT COUNT(*) c FROM remote_cache WHERE body LIKE '%EVIL%'").c, 0);
    B.peers.call = real;
    const ok = await B.remote.open(A.account, { force: true }); assert.equal(ok.posts[0].content, 'genuine');
    B.peers.call = async () => { throw Object.assign(new Error('down'), { code: 'timeout' }); };
    const stale = await B.remote.open(A.account, { force: true }); assert.equal(stale.stale, true); assert.equal(stale.posts[0].content, 'genuine');
  } finally { await stopAll(A, B, seed); }
});

test('P6 linking trusted peers does NOT start bulk sync by default; it is an explicit opt-in', async () => {
  let A, B;
  try {
    A = await mkHub('alice'); B = await mkHub('bob');
    const pa = A.peers.add(B.base, { state: 'trusted' }); const pb = B.peers.add(A.base, { state: 'trusted' });
    assert.equal(pa.sync_content, 0);
    await A.owner.post('/api/posts', { content: 'from A' });
    const r = await B.peers.syncPeer(B.peers.get(pb.id)); assert.equal(r.ok, true); assert.equal(r.handshake_only, true);
    await new Promise((x) => setTimeout(x, 1500));
    assert.equal((await B.owner.get('/api/feed/public')).json.items.length, 0, 'no auto-sync of posts');
    assert.equal(B.spy.count(/\/federation\/v1\/(events|inbox)/), 0);
    assert.ok(B.peers.get(pb.id).last_ok, 'but the trusted link is still health-checked');
    // the serving side refuses bulk pulls from peers without opt-in
    const sig = require('../../src/federation/protocol').signRequest(B.ks, B.account, { method: 'GET', pathQuery: '/federation/v1/events?cursor=0&limit=10', aud: A.account });
    const bulk = await fetch(A.base + '/federation/v1/events?cursor=0&limit=10', { headers: sig }); assert.equal(bulk.status, 403); assert.equal((await bulk.json()).code, 'E_CONTENT_SYNC_OFF');
    const sig2 = require('../../src/federation/protocol').signRequest(B.ks, B.account, { method: 'GET', pathQuery: '/federation/v1/peers', aud: A.account });
    assert.deepEqual((await (await fetch(A.base + '/federation/v1/peers', { headers: sig2 })).json()).peers, [], 'peer list (addresses) is not revealed');
    // opt in on both sides → classic sync works again
    assert.equal((await A.owner.patch('/api/peers/' + pa.id, { sync_content: true })).status, 409, 'per-peer opt-in needs the global mode first');
    for (const H of [A, B]) assert.equal((await H.owner.req('PATCH', '/api/presence/settings', { content_sync: 'trusted' })).status, 200);
    await waitFor(async () => (await B.owner.get('/api/feed/public')).json.items.length === 1, 10000);
    // per-peer switch off stops it again
    assert.equal((await B.owner.patch('/api/peers/' + pb.id, { sync_content: false })).json.sync_content, false);
    await A.owner.post('/api/posts', { content: 'second from A' }); await new Promise((x) => setTimeout(x, 1500));
    assert.equal((await B.owner.get('/api/feed/public')).json.items.length, 1);
  } finally { await stopAll(A, B); }
});

test('P7 owner controls: disable presence (withdraws), searchable opt-out, embedded seed role', async () => {
  const S = await startHub({ presence: presenceCfg({ serve: true }) }); let A;
  try {
    S.cfg.publicUrl = S.base; await new Client(S.base).setup('seedowner');
    A = await mkHub('alice', { seeds: [S.base], display: 'Alice Findable' });
    await waitFor(() => S.directory.has(A.account), 8000);
    assert.equal((await fetch(S.base + '/presence/v1/search?q=findable')).status, 200);
    assert.equal((await A.owner.req('PATCH', '/api/presence/settings', { searchable: false })).status, 200);
    await waitFor(async () => (await (await fetch(S.base + '/presence/v1/search?q=findable')).json()).items.length === 0, 6000);
    assert.equal((await fetch(S.base + '/presence/v1/resolve?account=' + A.account)).status, 200, 'still resolvable by id');
    assert.equal((await A.owner.req('PATCH', '/api/presence/settings', { enabled: false })).json.state, 'local');
    await waitFor(() => !S.directory.has(A.account), 6000);
    assert.equal((await A.owner.req('PATCH', '/api/presence/settings', { region: 'zzz' })).status, 400);
    const bob = new Client(A.base); await bob.post('/api/register', { username: 'x', password: 'abcdefgh1' }); // registration is closed → not owner
    assert.equal((await new Client(A.base).req('PATCH', '/api/presence/settings', { enabled: true })).status, 401);
  } finally { await stopAll(A, S); }
});
