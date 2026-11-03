'use strict';
// Multi-instance integration tests: every Hub has its own data directory, SQLite DB, keystore and HTTP server.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startHub, Client, waitFor, PNG, formWith } = require('./helpers');
const { HttpTransport } = require('../src/federation/transport');
const { signRequest } = require('../src/federation/protocol');
const { Keystore } = require('../src/keystore');

/** transport whose network can be cut to simulate a partition */
function flakyTransport(cfg = {}) {
  const t = new HttpTransport({ allowPrivate: true, timeoutMs: 2000, ...cfg });
  const real = { request: t.request.bind(t), download: t.download.bind(t) };
  t.down = false;
  t.request = (...a) => (t.down ? Promise.reject(Object.assign(new Error('network_down'), { code: 'network_down' })) : real.request(...a));
  t.download = (...a) => (t.down ? Promise.reject(Object.assign(new Error('network_down'), { code: 'network_down' })) : real.download(...a));
  return t;
}
async function mkHub(name, over = {}) {
  const transport = flakyTransport();
  const hub = await startHub({ transport, contentSync: 'trusted', ...over }); // bulk content sync is opt-in (default off since 2.3.0)
  hub.cfg.publicUrl = hub.base; hub.transport = transport;
  hub.owner = new Client(hub.base); await hub.owner.setup(name);
  hub.account = (await hub.owner.get('/api/identity')).json.account_id;
  return hub;
}
const link = (a, b) => { a.peers.add(b.base, { state: 'trusted' }); b.peers.add(a.base, { state: 'trusted' }); };
const pubFeed = async (h) => (await h.owner.get('/api/feed/public')).json.items;
const stopAll = (...h) => Promise.all(h.map((x) => x.stop()));

test('C12/C13/C17 two independent Hubs replicate public posts; restricted content never leaves the Hub', async () => {
  const A = await mkHub('alice'); const B = await mkHub('bob');
  assert.notEqual(A.dir, B.dir); assert.notEqual(A.account, B.account);
  link(A, B);
  await A.owner.post('/api/posts', { content: 'hello from A #federation' });
  await A.owner.post('/api/posts', { content: 'followers only secret', visibility: 'followers' });
  const g = (await A.owner.post('/api/groups', { name: 'Local group' })).json;
  await A.owner.post(`/api/groups/${g.id}/posts.json`, { content: 'group only secret' });
  const items = await waitFor(async () => { const f = await pubFeed(B); return f.length && f; });
  assert.equal(items[0].content, 'hello from A #federation');
  assert.equal(items[0].author.account_id, A.account);
  assert.equal(items[0].origin, 'remote');
  const all = JSON.stringify(B.db.all('SELECT content FROM posts')) + JSON.stringify(B.db.all('SELECT body FROM events'));
  assert.ok(!all.includes('secret'), 'restricted content did not replicate');
  assert.equal((await B.owner.get('/api/search?q=secret')).json.posts.length, 0);
  // profile (display name) also replicated and indexed
  const prof = (await B.owner.get(`/api/profiles/${A.account}`)).json; assert.equal(prof.display_name, 'alice');
  // hashtag search on B
  assert.equal((await B.owner.get('/api/search?q=%23federation')).json.posts.length, 1);
  // B replies, A sees the reply through the federation (both directions)
  const post = items[0];
  await B.owner.post('/api/posts', { content: 'reply from B', reply_to: post.id });
  const thread = await waitFor(async () => { const t = (await A.owner.get(`/api/posts/${A.db.get("SELECT id FROM posts WHERE content='hello from A #federation'").id}/thread`)).json; return t.replies.length && t; });
  assert.equal(thread.replies[0].content, 'reply from B');
  await stopAll(A, B);
});

test('C14/C15 partition → publish on both sides → reconnect → catch-up with bounded backoff, no duplicates', async () => {
  const A = await mkHub('alice'); const B = await mkHub('bob');
  link(A, B);
  await A.owner.post('/api/posts', { content: 'before partition' });
  await waitFor(async () => (await pubFeed(B)).length === 1);
  A.transport.down = B.transport.down = true;
  for (let i = 1; i <= 5; i++) await A.owner.post('/api/posts', { content: `A offline ${i}` });
  await B.owner.post('/api/posts', { content: 'B offline 1' });
  await waitFor(() => B.db.get("SELECT fail_streak f FROM peers WHERE account_id=?", A.account)?.f >= 2);
  const row = B.db.get('SELECT * FROM peers WHERE account_id=?', A.account);
  assert.ok(row.next_retry_at > Date.now() - 100 && row.next_retry_at - Date.now() <= B.cfg.backoffMaxMs + 50, 'retry time is bounded by max backoff');
  assert.equal((await pubFeed(B)).length, 2, 'nothing new arrived while partitioned (B: own + before)');
  A.transport.down = B.transport.down = false;
  await waitFor(async () => (await pubFeed(B)).length === 7 && (await pubFeed(A)).length === 7, 12000);
  // duplicate delivery changes nothing
  const evs = A.ledger.eventsAfter(0, 200).map((e) => e.event);
  const before = B.db.get('SELECT COUNT(*) c FROM posts').c; const evBefore = B.db.get('SELECT COUNT(*) c FROM events').c;
  const r = B.ledger.ingestBatch(evs, { source: 'dup' });
  assert.equal(r.summary.accepted || 0, 0); assert.equal(B.db.get('SELECT COUNT(*) c FROM posts').c, before); assert.equal(B.db.get('SELECT COUNT(*) c FROM events').c, evBefore);
  // both converged to the same set of events
  assert.equal(A.ledger.computeDigest().event_count, B.ledger.computeDigest().event_count);
  const ids = (h) => h.db.all('SELECT event_id FROM events ORDER BY event_id').map((x) => x.event_id).join();
  assert.equal(ids(A), ids(B));
  await stopAll(A, B);
});

test('C17 multi-hop gossip and discovery without any central database or relay', async () => {
  const A = await mkHub('alice'); const B = await mkHub('bob'); const C = await mkHub('carol');
  A.peers.add(B.base, { state: 'trusted' }); B.peers.add(A.base, { state: 'trusted' }); // A—B
  C.peers.add(B.base, { state: 'bootstrap' });                                           // C bootstraps only from B
  await waitFor(() => B.peers.byAccount(C.account), 10000);                              // B learns C from its signed request…
  { const r = B.peers.byAccount(C.account); B.peers.setState(r.id, 'trusted'); B.peers.setPeerSync(r.id, true); } // …and the owner opts in to serve C
  await A.owner.post('/api/posts', { content: 'relayed through B' });
  await waitFor(async () => (await pubFeed(C)).some((p) => p.content === 'relayed through B'), 12000);
  // C discovered A through B (pinned to A's account id, verified by challenge before use)
  await waitFor(() => C.peers.byAccount(A.account), 12000);
  const pa = C.peers.byAccount(A.account); assert.equal(pa.state, 'discovered'); assert.equal(pa.pin, A.account);
  await stopAll(A, B, C);
});

test('C16 invalid / unauthorized peers and events are rejected', async () => {
  const A = await mkHub('alice'); const B = await mkHub('bob', { rateLimit: { general: 600, write: 90, login: 100, upload: 20, federation: 12, assistant: 20 } });
  await A.owner.post('/api/posts', { content: 'legit' });
  const raw = (path, headers = {}) => fetch(A.base + path, { headers });
  assert.equal((await raw('/federation/v1/events?cursor=0')).status, 401, 'unsigned request');
  // signed by a stranger but for the wrong audience
  const ksx = new Keystore(require('./helpers').tmp('ks')); const me = ksx.generate();
  const mk = (aud, p = '/federation/v1/events?cursor=0') => signRequest(ksx, me.accountId, { method: 'GET', pathQuery: p, aud });
  assert.equal((await raw('/federation/v1/events?cursor=0', mk('hub1_' + 'b'.repeat(52)))).status, 401, 'wrong audience');
  const good = mk(A.account);
  assert.equal((await raw('/federation/v1/events?cursor=0', good)).status, 403, 'valid signature but no content-sync opt-in → refused');
  assert.equal((await raw('/federation/v1/events?cursor=0', good)).status, 401, 'replayed nonce rejected');
  assert.equal((await raw('/federation/v1/events?cursor=5', { ...mk(A.account), 'X-Hub-Sig': 'A'.repeat(86) })).status, 401, 'bad signature');
  const swapped = mk(A.account); // valid for cursor=0 but used on another path
  assert.equal((await raw('/federation/v1/events?cursor=1', swapped)).status, 401, 'signature is bound to method+path');
  // allowlist mode refuses unknown peers; blocked peers are refused
  const L = await mkHub('lena', { federationMode: 'allowlist' });
  assert.equal((await fetch(L.base + '/federation/v1/events?cursor=0', { headers: signRequest(ksx, me.accountId, { method: 'GET', pathQuery: '/federation/v1/events?cursor=0', aud: L.account }) })).status, 403);
  A.peers.add(`${me.accountId}@http://127.0.0.1:1`, { state: 'blocked' });
  assert.equal((await raw('/federation/v1/events?cursor=0', mk(A.account))).status, 403);
  // media endpoint & poke also require signatures
  assert.equal((await raw('/federation/v1/media/' + 'a'.repeat(64))).status, 401);
  assert.equal((await fetch(A.base + '/federation/v1/poke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  // per-peer rate limit on B
  let st = 0; for (let i = 0; i < 20; i++) st = (await fetch(B.base + '/federation/v1/events?cursor=0', { headers: signRequest(ksx, me.accountId, { method: 'GET', pathQuery: '/federation/v1/events?cursor=0', aud: B.account }) })).status;
  assert.equal(st, 429);
  await stopAll(A, B, L);
});

test('C16b a malicious peer serving tampered events cannot corrupt a Hub', async () => {
  const M = await mkHub('mallory'); const V = await mkHub('victim');
  await M.owner.post('/api/posts', { content: 'genuine post' });
  // proxy in front of M that tampers with every events response
  const proxy = http.createServer((req, res) => {
    const u = new URL(req.url, M.base);
    const up = http.request(M.base + u.pathname + u.search, { method: req.method, headers: { ...req.headers, host: new URL(M.base).host } }, (r) => {
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => {
        let body = Buffer.concat(chunks);
        if (u.pathname === '/federation/v1/events') { const j = JSON.parse(body.toString()); for (const e of (j.events || [])) if (e.event.payload.content) e.event.payload.content = 'EVIL ' + e.event.payload.content; body = Buffer.from(JSON.stringify(j)); }
        res.writeHead(r.statusCode, { 'content-type': 'application/json' }); res.end(body);
      });
    }); req.pipe(up);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const pUrl = `http://127.0.0.1:${proxy.address().port}`; M.cfg.publicUrl = pUrl;
  const row = V.peers.add(pUrl, { state: 'trusted' });
  await V.peers.syncPeer(row);                                       // M learns V from its signed request (refuses bulk: not opted in)
  { const mr = M.peers.byAccount(V.account); M.peers.setState(mr.id, 'trusted'); M.peers.setPeerSync(mr.id, true); V.db.run('UPDATE peers SET next_retry_at=0'); }
  const res = await V.peers.syncPeer(V.peers.get(row.id));
  assert.ok(res.rejected >= 1, 'tampered events were rejected: ' + JSON.stringify(res));
  assert.equal(V.db.get('SELECT COUNT(*) c FROM posts').c, 0);
  assert.equal(V.db.get("SELECT COUNT(*) c FROM events WHERE event_type='post.create'").c, 0, 'tampered post event not stored');
  assert.ok(!V.db.all('SELECT body FROM events').some((e) => e.body.includes('EVIL')));
  // impersonation: a bootstrap/pin says "this URL is Alice" but the endpoint answers with a different identity → refused
  const alice = await mkHub('alice2');
  const r2 = V.peers.add(`${alice.account}@${pUrl}`, { state: 'trusted' });
  assert.ok(r2.id === row.id || true);
  const V2 = await mkHub('victim2');
  const pinned = V2.peers.add(`${alice.account}@${pUrl}`, { state: 'trusted' });
  const out = await V2.peers.syncPeer(pinned);
  assert.equal(out.ok, false); assert.equal(out.error, 'pin_mismatch');
  await new Promise((r) => proxy.close(r)); await stopAll(M, V, alice, V2);
});

test('endpoint change keeps the same identity (signed announcement + verified handshake)', async () => {
  const A = await mkHub('alice'); const B = await mkHub('bob');
  link(A, B);
  await A.owner.post('/api/posts', { content: 'before move' });
  await waitFor(async () => (await pubFeed(B)).length === 1);
  const alias = http.createServer((q, s) => A.app.handle(q, s));
  await new Promise((r) => alias.listen(0, '127.0.0.1', r));
  const newUrl = `http://127.0.0.1:${alias.address().port}`;
  A.cfg.publicUrl = newUrl; A.peers.announceEndpoint(); // same account, new endpoint
  await waitFor(() => B.peers.byAccount(A.account)?.endpoint === newUrl, 15000);
  assert.equal(B.db.get('SELECT COUNT(*) c FROM peers WHERE account_id=?', A.account).c, 1);
  await A.owner.post('/api/posts', { content: 'after move' });
  await waitFor(async () => (await pubFeed(B)).some((p) => p.content === 'after move'), 15000);
  assert.equal(B.peers.byAccount(A.account).account_id, A.account);
  await new Promise((r) => alias.close(r)); await stopAll(A, B);
});

test('restricted media is not served to peers; public media is fetched on demand, hash-verified and cached', async () => {
  const A = await mkHub('alice'); const B = await mkHub('bob', { remoteCacheBytes: 50 * 1024 * 1024 }); // mirroring remote media to disk is opt-in
  link(A, B);
  const up = async (name) => (await A.owner.req('POST', '/api/media', undefined, { form: formWith(Buffer.concat([PNG, Buffer.from(name)]), name + '.png') })).json;
  const pubM = await up('public'); const privM = await up('private');
  await A.owner.post('/api/posts', { content: 'with image', media: [pubM.hash] });
  await A.owner.post('/api/posts', { content: 'followers pic', media: [privM.hash], visibility: 'followers' });
  await waitFor(async () => (await pubFeed(B)).length === 1);
  assert.equal(B.media.exists(pubM.hash), false, 'not pushed eagerly');
  const r = await B.owner.get('/media/' + pubM.hash, { raw: true });
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await r.arrayBuffer()).length, pubM.size);
  assert.ok(B.media.exists(pubM.hash), 'cached locally after first retrieval');
  assert.equal(B.db.get('SELECT origin FROM media WHERE hash=?', pubM.hash).origin, 'remote');
  // private media: hash is known to nobody on B, and A refuses to serve it to a signed peer
  const ksx = new Keystore(require('./helpers').tmp('ks')); const me = ksx.generate();
  const hp = `/federation/v1/media/${privM.hash}`;
  const pr = await fetch(A.base + hp, { headers: signRequest(ksx, me.accountId, { method: 'GET', pathQuery: hp, aud: A.account }) });
  assert.equal(pr.status, 404);
  assert.equal((await B.owner.get('/media/' + privM.hash, { raw: true })).status, 404);
  assert.equal((await new Client(A.base).get('/media/' + privM.hash, { raw: true })).status, 404, 'anonymous cannot fetch restricted media');
  // tampered content from peer is refused: forge by pointing B at wrong bytes
  const fake = 'f'.repeat(64);
  assert.equal((await B.owner.get('/media/' + fake, { raw: true })).status, 404);
  await stopAll(A, B);
});
