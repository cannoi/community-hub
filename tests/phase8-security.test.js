'use strict';
/**
 * Phase 8 — cross-phase attack matrix (acceptance D). Everything runs against real Hubs / real components. Attacks that need a hostile
 * *network* (DDoS, eclipse, BGP, Sybil at scale) cannot be proven here and are listed as out of scope in docs/RELEASE_SCORECARD.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { startHub, Client } = require('./helpers');
const { Keystore } = require('../src/keystore');
const { signRequest } = require('../src/federation/protocol');
const { validateEndpoint } = require('../src/federation/transport');
const { checkDial } = require('../src/net/p2p/policy');

const PW = 'correct-horse-9';
const RL = { general: 50000, write: 50000, login: 5000, upload: 500, federation: 50000, assistant: 50 };
const hubs = []; const dirs = [];
const mk = async (over = {}) => { const h = await startHub({ allowRegistration: true, contentSync: 'trusted', rateLimit: RL, healing: { intervalMs: 0, cycleBudgetMs: 250 }, ...over }); hubs.push(h); return h; };
test.after(async () => { for (const h of hubs) { try { await h.stop(); } catch {} } for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const stranger = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-ks-')); dirs.push(dir); const ks = new Keystore(path.join(dir, 'ks'), ''); const account = ks.generate().accountId; return { ks, account }; };
const signed = (m, hub, pathQuery, method = 'GET') => signRequest(m.ks, m.account, { method, pathQuery, aud: hub.peers.self().account });

// ---------------------------------------------------------------------------------------------------------------- fake peer / signatures / replay
test('D1 fake peer: unsigned, forged and mismatched federation requests are refused', async () => {
  const hub = await mk(); await new Client(hub.base).setup('owner', PW); const m = stranger(); const evil = stranger(); const url = hub.base + '/federation/v1/events?cursor=0&limit=5';
  assert.equal((await fetch(url)).status, 401, 'no signature');
  const h = signed(m, hub, '/federation/v1/events?cursor=0&limit=5');
  assert.equal((await fetch(url, { headers: { ...h, 'X-Hub-Pub': evil.ks.publicKey(evil.account) } })).status, 401, 'public key does not belong to the claimed account');
  assert.equal((await fetch(url, { headers: { ...h, 'X-Hub-Account': evil.account } })).status, 401, 'account swapped');
  assert.equal((await fetch(url, { headers: { ...h, 'X-Hub-Sig': 'A'.repeat(86) } })).status, 401, 'garbage signature');
  const ok = await fetch(url, { headers: signed(m, hub, '/federation/v1/events?cursor=0&limit=5') }); assert.equal(ok.status, 200, 'a correctly signed request works');
});
test('D2 replay: a captured signed request cannot be replayed; stale, future, wrong-audience and re-targeted requests fail', async () => {
  const hub = await mk(); await new Client(hub.base).setup('owner', PW); const m = stranger(); const pq = '/federation/v1/events?cursor=0&limit=5'; const url = hub.base + pq;
  const h = signed(m, hub, pq); assert.equal((await fetch(url, { headers: h })).status, 200);
  const replay = await fetch(url, { headers: h }); assert.equal(replay.status, 401); assert.match(JSON.stringify(await replay.json()), /replay/i);
  const old = signed(m, hub, pq); old['X-Hub-Time'] = String(Date.now() - 3600000); assert.equal((await fetch(url, { headers: old })).status, 401, 'stale timestamp');
  const fut = signed(m, hub, pq); fut['X-Hub-Time'] = String(Date.now() + 3600000); assert.equal((await fetch(url, { headers: fut })).status, 401, 'future timestamp');
  const other = stranger(); const wrongAud = signRequest(m.ks, m.account, { method: 'GET', pathQuery: pq, aud: other.account }); assert.equal((await fetch(url, { headers: wrongAud })).status, 401, 'signed for another Hub');
  const h2 = signed(m, hub, pq); assert.equal((await fetch(hub.base + '/federation/v1/events?cursor=0&limit=50', { headers: h2 })).status, 401, 'signature bound to the exact path+query');
  const post = signed(m, hub, '/federation/v1/inbox', 'POST'); assert.ok([400, 401, 403, 404, 405, 413].includes((await fetch(hub.base + '/federation/v1/events?cursor=0&limit=5', { method: 'POST', headers: post, body: '{}' })).status), 'method is bound too');
});
test('D3 invalid signatures inside payloads: forged and tampered ledger events are rejected, never stored', async () => {
  const S = await mk(); const R = await mk(); const a = new Client(S.base); await a.setup('alice', PW); await a.post('/api/posts', { content: 'honest post' });
  const ev = JSON.parse(S.db.get("SELECT body FROM events WHERE event_type='post.create' LIMIT 1").body);
  const before = R.db.get('SELECT COUNT(*) c FROM events').c;
  const forged = JSON.parse(JSON.stringify(ev)); forged.payload.content = 'FORGED CONTENT';
  const sigFlip = JSON.parse(JSON.stringify(ev)); sigFlip.signature = ev.signature.replace(/^./, ev.signature[0] === 'A' ? 'B' : 'A');
  const wrongActor = JSON.parse(JSON.stringify(ev)); wrongActor.actor_id = stranger().account;
  for (const bad of [forged, sigFlip, wrongActor, { ...ev, event_id: 'ev1_' + '0'.repeat(64) }, { junk: true }, null, 'x']) { let r; try { r = R.ledger.ingest(bad, { source: 'attack' }); } catch { r = { status: 'rejected' }; } assert.notEqual(r.status, 'accepted'); }
  assert.equal(R.db.get('SELECT COUNT(*) c FROM events').c, before, 'nothing stored');
  R.remote.cacheEvents([forged, sigFlip]); assert.equal(R.db.get('SELECT COUNT(*) c FROM remote_cache').c, 0, 'discovery cache verifies too');
});

// ---------------------------------------------------------------------------------------------------------------- oversized payloads / parser abuse
test('D4 oversized payloads and parser bombs: 413/400, never a crash, Hub keeps serving', async () => {
  const hub = await mk(); const c = new Client(hub.base); await c.setup('owner', PW);
  const big = 'x'.repeat(6 * 1024 * 1024);
  const refused = async (p) => { try { const r = await p; return r.status >= 400 && r.status < 500; } catch (e) { return /ECONNRESET|socket|fetch failed|EPIPE/i.test(String(e && (e.cause && e.cause.code || e.message))); } };   // refusing early may reset the connection
  assert.ok(await refused(fetch(hub.base + '/api/posts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: big }) })), 'anonymous 6 MB post refused');
  assert.ok(await refused(c.post('/api/posts', { content: big })), 'API rejects a 6 MB post');
  const m = stranger(); assert.ok(await refused(fetch(hub.base + '/federation/v1/inbox', { method: 'POST', headers: { ...signed(m, hub, '/federation/v1/inbox', 'POST'), 'content-type': 'application/json' }, body: big })), 'inbox refused');
  assert.ok(await refused(fetch(hub.base + '/p2p/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ record: { pad: big } }) })), 'register refused');
  const nest = '['.repeat(200000) + ']'.repeat(200000); assert.ok(await refused(fetch(hub.base + '/p2p/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: nest })), 'deep nesting refused');
  const q = await c.get('/api/search?q=' + encodeURIComponent('a'.repeat(100000))); assert.ok(q.status < 500, 'long query: ' + q.status);
  const nul = await c.get('/api/search?q=%00%00%ff'); assert.ok(nul.status < 500);
  assert.equal((await c.get('/api/session')).status, 200, 'Hub still serving');
});

// ---------------------------------------------------------------------------------------------------------------- SSRF
test('D5 SSRF: private, loopback, link-local, metadata, odd encodings and non-http schemes are refused as peer endpoints', async () => {
  const bad = ['http://127.0.0.1:8181', 'http://localhost:8181', 'http://[::1]:8181', 'http://0.0.0.0:8181', 'http://10.0.0.5', 'http://192.168.1.10:8181', 'http://172.16.0.9', 'http://169.254.169.254/latest/meta-data',
    'http://2130706433', 'http://0x7f.0.0.1', 'http://127.1', 'http://metadata.google.internal', 'http://printer.local', 'http://intranet.corp', 'file:///etc/passwd', 'gopher://x', 'ftp://x', 'javascript:alert(1)', 'http://[::ffff:127.0.0.1]', 'http://user:pass@8.8.8.8:80',
    'https://127.0.0.1', 'https://10.0.0.5', 'https://192.168.1.10', 'https://169.254.169.254', 'https://localhost', 'https://[::1]', 'https://metadata.google.internal', 'https://nas.local'];   // https must not be a bypass either
  for (const u of bad) assert.throws(() => validateEndpoint(u, { allowPrivate: false }), `${u} must be refused`);
  assert.doesNotThrow(() => validateEndpoint('http://8.8.8.8:8181', { allowPrivate: false }));
  for (const a of ['/ip4/127.0.0.1/tcp/4001/ws', '/ip4/10.1.2.3/tcp/4001/ws', '/ip4/169.254.169.254/tcp/80/ws', '/ip4/192.168.0.2/tcp/4001/ws', '/ip6/::1/tcp/4001/ws', '/dns4/localhost/tcp/4001/ws']) assert.throws(() => checkDial(a), `${a} must be refused for dialing`);
  const hub = await mk({ allowPrivatePeers: false }); const c = new Client(hub.base); await c.setup('owner', PW);   // the test helper normally allows loopback peers
  for (const u of ['http://127.0.0.1:1', 'http://169.254.169.254', 'file:///etc/passwd']) { const r = await c.post('/api/peers', { endpoint: u }); assert.ok(r.status >= 400 && r.status < 500, `${u} -> ${r.status}`); }
  assert.equal(hub.db.get('SELECT COUNT(*) c FROM peers').c, 0, 'nothing was added');
});

// ---------------------------------------------------------------------------------------------------------------- directory poisoning
test('D6 directory poisoning: malformed, expired, far-future, mismatched, private and unverifiable peer records never enter the registry', async () => {
  const hub = await mk(); const probe = require('../src/net/p2p/bootstrap/probe'); const real = probe.probePeerRecord; let probed = 0; probe.probePeerRecord = async () => { probed++; return { verified: false, reason: 'unreachable' }; };
  let registered = 0; hub.net = { registerBootstrapPeer() { registered++; return { accepted: 1 }; } };
  try {
    const id = '12D3KooWpoisonTest123456789ABCDEFGHJKLMNPQRSTUVWXYZab'; const now = Date.now();
    const good = { peer_id: id, network: 'cannoi', protocol: '1', registered_at: now, expires_at: now + 3600000, multiaddrs: [`/ip4/8.8.8.8/tcp/8181/ws/p2p/${id}`] };
    const attempts = [{ ...good, network: 'other' }, { ...good, expires_at: now - 1000 }, { ...good, expires_at: now + 30 * 86400000 }, { ...good, multiaddrs: [] }, { ...good, multiaddrs: Array(20).fill(good.multiaddrs[0]) },
      { ...good, multiaddrs: ['/ip4/8.8.8.8/tcp/8181/ws/p2p/12D3KooWsomeoneElse123456789ABCDEFGHJKLMNPQRSTUVWXYZab'] }, { ...good, multiaddrs: [`/ip4/10.0.0.1/tcp/8181/ws/p2p/${id}`] }, { ...good, multiaddrs: [`/ip4/127.0.0.1/tcp/8181/ws/p2p/${id}`] },
      { ...good, peer_id: 'x' }, { ...good, peer_id: 'y'.repeat(500) }, { ...good, multiaddrs: ['A'.repeat(600)] }, null, 'str', { ...good, multiaddrs: 'nope' }];
    for (const rec of attempts) { const r = await fetch(hub.base + '/p2p/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ record: rec }) }); assert.ok(r.status === 400 || (await r.clone().json()).accepted === 0, 'rejected'); }
    const ok = await (await fetch(hub.base + '/p2p/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ record: good }) })).json();
    assert.equal(ok.accepted, 0); assert.equal(ok.verified, false); assert.ok(probed >= 1, 'well-formed record was probed back and failed'); assert.equal(registered, 0, 'registry untouched');
  } finally { probe.probePeerRecord = real; }
});

// ---------------------------------------------------------------------------------------------------------------- unauthorized private content
test('D7 private content: followers-only and group posts never reach strangers through feeds, search, direct reads, federation or network search', async () => {
  const hub = await mk({ p2p: { enabled: false } }); const alice = new Client(hub.base); await alice.setup('alice', PW);
  const bob = new Client(hub.base); await bob.post('/api/register', { username: 'bob', password: PW }); await bob.login('bob', PW);
  const eve = new Client(hub.base);
  await alice.post('/api/posts', { content: 'PUBLICWORD hello world' });
  const priv = await alice.post('/api/posts', { content: 'FOLLOWERSECRET only for followers', visibility: 'followers' });
  const g = (await alice.post('/api/groups', { name: 'secret club', visibility: 'private' })).json; const gid = g.id || (g.group && g.group.id);
  if (gid) await alice.post('/api/groups/' + gid + '/posts.json', { content: 'GROUPSECRET inside the club' });
  const privId = hub.db.get("SELECT id, event_id FROM posts WHERE content LIKE 'FOLLOWERSECRET%'");
  const dump = async (client, p) => JSON.stringify((await client.get(p)).json || {});
  for (const who of [bob, eve]) {
    for (const p of ['/api/feed/public', '/api/search?q=FOLLOWERSECRET', '/api/search?q=GROUPSECRET', '/api/search?q=secret', '/api/explore/network?q=FOLLOWERSECRET', '/api/trends']) { const d = await dump(who, p); assert.ok(!d.includes('FOLLOWERSECRET') && !d.includes('GROUPSECRET'), `leak via ${p}`); }
    assert.ok((await who.get('/api/posts/' + privId.id)).status >= 403 || (await who.get('/api/posts/' + privId.id)).status === 404, 'direct read refused');
  }
  if (gid) { assert.ok((await bob.get('/api/groups/' + gid + '/posts')).status >= 403); assert.ok(!(await dump(bob, '/api/groups'))?.includes('GROUPSECRET')); }
  const m = stranger(); const ev = await fetch(hub.base + '/federation/v1/events?cursor=0&limit=500', { headers: signed(m, hub, '/federation/v1/events?cursor=0&limit=500') }); const evt = await ev.text();
  assert.ok(!evt.includes('FOLLOWERSECRET') && !evt.includes('GROUPSECRET'), 'federation exposes only public ledger events');
  const snap = await fetch(hub.base + '/federation/v1/actor/' + hub.db.get('SELECT account_id FROM users LIMIT 1').account_id + '/snapshot?limit=50', { headers: signed(m, hub, '/federation/v1/actor/' + hub.db.get('SELECT account_id FROM users LIMIT 1').account_id + '/snapshot?limit=50') });
  assert.ok(!(await snap.text()).includes('FOLLOWERSECRET'), 'snapshot excludes non-public posts');
  const { PostIndexer } = require('../src/net/p2p/post-indexer'); const { DistributedIndex } = require('../src/net/p2p/distributed-index'); const ix = new DistributedIndex({ db: hub.db, localPeerId: () => 'P8' }); new PostIndexer({ db: hub.db, index: ix, selfId: 'P8', region: 'VN' }).syncAll();
  assert.equal(ix.searchLocal('FOLLOWERSECRET').items.length, 0); assert.equal(ix.searchLocal('GROUPSECRET').items.length, 0); assert.equal(ix.searchLocal('PUBLICWORD').items.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------- auth / abuse
test('D8 auth and abuse: login brute force is throttled, protected endpoints need a session, admin endpoints are owner-only, spam is rate limited', async () => {
  const hub = await mk({ rateLimit: { ...RL, login: 6, write: 8 } }); const owner = new Client(hub.base); await owner.setup('owner', PW);
  const codes = []; for (let i = 0; i < 12; i++) codes.push((await new Client(hub.base).post('/api/login', { username: 'owner', password: 'wrong-' + i })).status);
  assert.ok(codes.includes(429), 'brute force throttled: ' + codes.join());
  const anon = new Client(hub.base);
  for (const p of ['/api/me', '/api/admin/healing', '/api/explore/network', '/api/peers', '/api/admin/reindex']) assert.ok([401, 403, 404, 405].includes((await anon.get(p)).status), p);
  const bob = new Client(hub.base); const reg = await bob.post('/api/register', { username: 'bob', password: PW }); if (reg.status < 300) { await bob.login('bob', PW); for (const p of ['/api/admin/healing', '/api/admin/users']) assert.ok((await bob.get(p)).status >= 403, 'non-owner: ' + p); }
  const spam = []; for (let i = 0; i < 30; i++) spam.push((await owner.post('/api/posts', { content: 'spam ' + i })).status); assert.ok(spam.includes(429), 'write limiter: ' + spam.join());
  assert.equal((await new Client(hub.base).get('/api/session')).status, 200, 'public endpoints stay up');
});
test('D9 resource exhaustion at the HTTP layer: slow/abusive connections are bounded by server timeouts and request caps', async () => {
  const hub = await mk(); const srv = hub.server;
  assert.ok(srv.headersTimeout > 0 && srv.headersTimeout <= 30000, 'headersTimeout ' + srv.headersTimeout); assert.ok(srv.keepAliveTimeout <= 10000); assert.ok(srv.maxRequestsPerSocket > 0);
  assert.equal(srv.connectionsCheckingInterval, 5000, 'timeouts are enforced every 5 s (Node default is 30 s)');
  srv.headersTimeout = 2000;                                                                // shorten only to keep the test fast; the mechanism is what is verified
  const net = require('net'); const port = new URL(hub.base).port; const sock = net.connect(port, '127.0.0.1'); await new Promise((r) => sock.on('connect', r)); sock.resume(); sock.write('GET /api/session HTTP/1.1\r\nHost: x\r\nX-A: ');   // never finishes the headers
  const t0 = Date.now(); const closed = await Promise.race([new Promise((r) => sock.on('close', () => r(true))), new Promise((r) => setTimeout(() => r(false), 12000))]); sock.destroy();
  assert.equal(closed, true, 'slowloris connection is dropped'); assert.ok(Date.now() - t0 <= 9000, 'dropped within one check interval: ' + (Date.now() - t0));
  assert.equal((await new Client(hub.base).get('/api/session')).status, 200);
});

// ---------------------------------------------------------------------------------------------------------------- scale guards (Phase 8 optimisations keep behaviour)
const { DistributedIndex } = require('../src/net/p2p/distributed-index');
const { RegionalDirectory } = require('../src/net/p2p/bootstrap/directory');
test('Phase 8 optimisations keep behaviour: planAssignments top-k == full sort; Directory.query pages == full sort; search planning is bounded', async () => {
  const ix = new DistributedIndex({ localPeerId: () => 'x' }); const peers = Array.from({ length: 400 }, (_, i) => ({ peer_id: 'peer' + i, verified: true, trust_state: 'TRUSTED', capacity: (i % 10 + 1) / 10 }));
  const { rendezvousScore } = require('../src/net/p2p/distributed-index');
  for (const shard of [0, 7, 63]) {
    const ref = peers.map((n) => ({ id: n.peer_id, s: rendezvousScore(shard, n.peer_id) * Math.min(1, Math.max(0.05, n.capacity)) })).sort((a, b) => b.s - a.s || a.id.localeCompare(b.id)).slice(0, 3).map((x) => x.id);
    const p = ix.planAssignments([shard], peers, { replicas: 3 })[0]; assert.deepEqual([p.primary.peer_id, ...p.replicas.map((r) => r.peer_id)], ref);
  }
  const pw = ix.planAssignments([5], peers, { replicas: 3, capacityPower: 4 })[0]; assert.ok(pw.primary.peer_id);
  const d = new RegionalDirectory({ maxEntries: 5000 }); for (let i = 0; i < 300; i++) d.put({ peer_id: 'dir' + i, multiaddrs: ['/ip4/8.8.8.8/tcp/1'], region: ['VN', 'JP', 'US'][i % 3], languages: i % 2 ? ['vi'] : ['en'], verified: true });
  const all = [...d._byId.values()]; const pref = (e) => (e.region === 'JP' ? 2 : 0) + (e.languages.includes('vi') ? 1 : 0);
  const ref = all.slice().sort((a, b) => pref(b) - pref(a) || b.seq - a.seq).slice(0, 20).map((e) => e.peer_id);
  assert.deepEqual(d.query({ region: 'JP', language: 'vi', limit: 20 }).items.map((e) => e.peer_id), ref);
  const page2 = d.query({ region: 'JP', language: 'vi', limit: 20, cursor: all[100].seq }); assert.ok(page2.items.every((e) => e.seq > all[100].seq));
});
test('Phase 8: search planning cost is bounded by maxPool; one slow Hub among many is not reported as a degraded search', () => {
  const { FederatedSearch } = require('../src/net/p2p/federated-search'); const C = require('../src/net/p2p/index-crypto'); const sg = C.createEd25519Signer();
  const many = Array.from({ length: 200000 }, (_, i) => ({ peer_id: C.b58encode(require('crypto').createHash('sha256').update('p' + i).digest()), region: 'JP', languages: ['ja'], topics: [] }));
  const f = new FederatedSearch({ index: {}, transport: {}, signer: sg, peers: () => many, config: {} });
  const t0 = Date.now(); const pool = f._pool({ sources: { skipped_open: 0 } }); assert.equal(pool.length, 1000); assert.ok(Date.now() - t0 < 500, 'planning ' + (Date.now() - t0) + ' ms');
  const st = (queried, ok, failed, skipped = 0) => f._finalState({ scope: 'auto', items: new Map([[1, 1]]), sources: { queried, ok, failed, skipped_open: skipped, throttled: 0 } });
  assert.equal(st(24, 23, 1), 'complete'); assert.equal(st(24, 18, 6), 'partial'); assert.equal(st(4, 3, 1), 'partial'); assert.equal(st(24, 0, 24), 'degraded'); assert.equal(st(0, 0, 0), 'local_only');
});
