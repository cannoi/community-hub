'use strict';
/**
 * Phase 6 tests: multilingual analysis, ranking, federated search, Global Explore and content-on-demand.
 * Network = in-process LoopbackNetwork (JSON round-trip) and a real-TCP multi-process simulation at the end. Neither is a
 * multi-machine or public-Internet test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { DistributedIndex, tokenize: legacyTokenize } = require('../src/net/p2p/distributed-index');
const ST = require('../src/net/p2p/search-text');
const RK = require('../src/net/p2p/search-ranking');
const { SearchService, FederatedSearch, projectPost } = require('../src/net/p2p/federated-search');
const { ResourceGovernor, LoopbackNetwork } = require('../src/net/p2p/index-governor');
const C = require('../src/net/p2p/index-crypto');
const { TrustEngine } = require('../src/net/p2p/trust-engine');

const NOW = Date.now();
const DAY = 86400000;
const strongProbes = { load1: () => 0.1, cpus: () => 8, totalMemMb: () => 16000, rssMb: () => 100, freeDiskMb: () => 100000 };
const trustAll = { stateOf: () => 'TRUSTED', allow: () => ({ ok: true }), observe() {} };

// ------------------------------------------------------------------------------------------------------------ harness
function makeWorld(t, specs, { trust = trustAll, cfg = {}, net = new LoopbackNetwork(), setup = null, clock = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsearch-'));
  const hubs = specs.map((spec, i) => {
    const signer = C.createEd25519Signer(); const id = signer.peerId;
    const db = openDatabase(path.join(dir, `h${i}.sqlite`));
    const index = new DistributedIndex({ db, localPeerId: () => id });
    const governor = new ResourceGovernor({ index, probes: strongProbes });
    const transport = net.attach(id);
    const hub = { i, id, spec, signer, db, index, governor, transport, net, published: new Map() };
    hub.service = new SearchService({ index, signer, selfId: id, trust, governor, isStillPublic: (cid) => hub.published.get(cid) !== false, config: cfg.service, contentProvider: (...a) => (hub.contentProvider ? hub.contentProvider(...a) : { status: 'not_found' }) });
    hub.add = (text, o = {}) => {
      const cid = o.id || ('post-' + (hub.i) + '-' + (hub.nDocs = (hub.nDocs || 0) + 1));
      const r = index.upsertDocument({ origin_peer: id, content_id: cid, visibility: o.visibility || 'public', title: o.title || '', text, language: o.language || ST.detectLanguage(text).lang, region: o.region || spec.region, topics: o.topics || ST.mapTopics(text), updated_at: o.updated_at || (NOW - (o.ageDays || 1) * DAY) }, { local: true });
      assert.equal(r.ok, true, JSON.stringify(r)); return cid;
    };
    return hub;
  });
  const entry = (h) => ({ peer_id: h.id, region: h.spec.region, languages: h.spec.languages, topics: h.spec.topics || [] });
  if (setup) for (const h of hubs) setup(h);
  for (const h of hubs) {
    h.fed = new FederatedSearch({ index: h.index, transport: h.transport, signer: h.signer, selfId: h.id, trust, governor: h.governor, profile: { region: h.spec.region, languages: h.spec.languages },
      peers: () => hubs.filter((x) => x !== h && !(h.spec.knows && !h.spec.knows.includes(x.i))).map(entry), config: { stageTimeoutMs: 800, totalTimeoutMs: 4000, ...cfg.fed }, verifyEvents: (...a) => (h.verifyEvents ? h.verifyEvents(...a) : 0), contentProvider: (...a) => (h.contentProvider ? h.contentProvider(...a) : { status: 'not_found' }), ...(clock ? { now: () => clock.t } : {}) });
  }
  t.after(() => { for (const h of hubs) { try { h.db.close(); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); });
  return { hubs, net, start: async () => { for (const h of hubs) await h.transport.start((from, msg) => h.service.handle(from, msg)); } };
}
const WORLD = [
  { region: 'VN', languages: ['vi', 'en'] },                 // 0 the searching Hub (Vietnam)
  { region: 'JP', languages: ['ja', 'en'], topics: ['travel', 'food'] },   // 1 Japan
  { region: 'DE', languages: ['de', 'en'], topics: ['tech'] },             // 2 Germany (Europe)
  { region: 'FR', languages: ['fr', 'en'], topics: ['food'] },             // 3 France (Europe)
  { region: 'VN', languages: ['vi'] },                                     // 4 another Vietnamese Hub
];
const ids = (snap) => snap.items.map((i) => i.content_id);

// ============================================================================================================ text analysis
test('tokenizer v2: Vietnamese with/without diacritics are equivalent, Latin output is unchanged from Phase 5', () => {
  assert.deepEqual(ST.tokenize('Cộng đồng Việt Nam'), ST.tokenize('cong dong viet nam'));
  assert.deepEqual(ST.tokenize('Đà Nẵng đẹp quá'), ['da', 'nang', 'dep', 'qua']);
  assert.deepEqual(legacyTokenize('Cộng đồng Pi Network'), ['cong', 'dong', 'pi', 'network']);
  assert.deepEqual(ST.tokenize('The quick brown fox and the lazy dog'), ['quick', 'brown', 'fox', 'lazy', 'dog']);
});
test('tokenizer v2: Japanese via script-run bigrams, katakana folds to hiragana, full-width folds to ASCII', () => {
  assert.deepEqual(ST.tokenize('日本の料理'), ['日本', '料理']);                         // の (single hiragana) is a separator
  assert.deepEqual(ST.tokenize('コミュニティ'), ST.tokenize('こみゅにてぃ'));
  assert.deepEqual(ST.tokenize('ｺﾐｭﾆﾃｨ'), ST.tokenize('コミュニティ'));                 // half-width katakana
  assert.deepEqual(ST.tokenize('ＡＢＣ　ｔｅｓｔ'), ['abc', 'test']);
  assert.ok(ST.tokenize('猫が好き').includes('猫'), 'single kanji is a word');
  assert.ok(ST.tokenize('今日は東京で友達と会いました').includes('東京'));
});
test('language detection: scripts, Vietnamese with and without accents, English, Latin languages', () => {
  const L = (s) => ST.detectLanguage(s).lang;
  assert.equal(L('Xin chào các bạn, hôm nay trời đẹp quá'), 'vi');
  assert.equal(L('cong dong viet nam rat dep va dang phat trien'), 'vi');
  assert.equal(L('The community is growing fast and we love it'), 'en');
  assert.equal(L('東京で友達と会いました'), 'ja'); assert.equal(L('こんにちは'), 'ja');
  assert.equal(L('今天天气很好我们去公园'), 'zh'); assert.equal(L('안녕하세요 여러분'), 'ko');
  assert.equal(L('привет мир как дела'), 'ru'); assert.equal(L('Hola, la comunidad es genial para todos'), 'es');
  assert.equal(L('Bonjour tout le monde, la communaute est belle'), 'fr'); assert.equal(L('   '), 'und'); assert.equal(L('12345 !!!'), 'und');
});
test('query analysis: cross-language aliases, morphology, topics; alias phrases never fire on unrelated words', () => {
  const a = ST.analyzeQuery('Cộng đồng');
  assert.deepEqual(a.terms.filter((x) => x.w === 1).map((x) => x.t), ['cong', 'dong']);
  assert.ok(a.forms.some((f) => f.kind === 'a' && f.toks.join(' ') === 'community'));
  assert.ok(a.forms.some((f) => f.kind === 'a' && f.toks.join(' ').startsWith('こみ')));
  assert.ok(ST.analyzeQuery('communities').forms.some((f) => f.kind === 'm' && f.toks[0] === 'community'));
  assert.deepEqual(ST.analyzeQuery('tokyo').topics, ['travel']);
  assert.ok(ST.analyzeQuery('am thuc').topics.includes('food') && ST.analyzeQuery('料理').topics.includes('food'));
  const t = ST.analyzeQuery('tokyo');                                                  // alias "dong kinh" must be a PHRASE
  assert.equal(RK.relevance(t, { title: '', text: 'Tôi có một nghìn đồng' }), 0);
  assert.ok(RK.relevance(t, { title: '', text: '東京のイベント' }) > 0.4);
  assert.ok(ST.analyzeQuery('x'.repeat(5000)).raw.length <= 200, 'query length bounded');
  assert.ok(ST.analyzeQuery('a b c d e f g h i j k l m n o p q r s t u v w x y z').terms.length <= 24, 'term count bounded');
});
test('optional translation expansion: off by default, bounded, failure-tolerant', async () => {
  const base = ST.analyzeQuery('đi bộ buổi sáng');
  assert.equal((await ST.translateExpand(base, null, ['en'])).translated, undefined);
  const tr = await ST.translateExpand(base, async () => ['morning walk'], ['vi', 'en']);
  assert.equal(tr.translated, true); assert.ok(tr.terms.some((x) => x.t === 'walk' && x.w === 0.5));
  assert.deepEqual((await ST.translateExpand(base, async () => { throw new Error('down'); }, ['en'])).terms, base.terms);
  const slow = await ST.translateExpand(base, () => new Promise(() => {}), ['en'], { timeoutMs: 30 }); assert.equal(slow.translated, undefined);
});
test('index migration: tokenizer v2 rebuilds DERIVED terms in batches and never touches documents', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-mig-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(path.join(dir, 'x.sqlite')); const ix = new DistributedIndex({ db, localPeerId: () => 'L' });
  for (let i = 0; i < 5; i++) ix.upsertDocument({ origin_peer: 'o', content_id: 'c' + i, visibility: 'public', title: '', text: '日本の料理 ' + i }, { local: true });
  db.run('DELETE FROM p2p_index_terms'); db.run("DELETE FROM p2p_index_meta WHERE k='tokenizer_version'");              // simulate a pre-v2 index
  const docsBefore = JSON.stringify(db.all('SELECT * FROM p2p_index_documents ORDER BY content_id'));
  let rounds = 0, r; do { r = ix.rebuildTermsIfNeeded({ batch: 2 }); rounds++; } while (!r.done && rounds < 10);
  assert.equal(rounds, 3); assert.equal(JSON.stringify(db.all('SELECT * FROM p2p_index_documents ORDER BY content_id')), docsBefore);
  assert.equal(ix.searchLocal('料理').items.length, 5);
  assert.equal(ix.rebuildTermsIfNeeded().rebuilt, 0, 'idempotent once at the current version');
  db.close();
});

// ============================================================================================================ ranking
test('ranking: spec weights sum to 1; freshness decays; language/region are soft; node trust is not an input', () => {
  const w = RK.DEFAULT_WEIGHTS; assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.deepEqual(w, { relevance: 0.40, quality: 0.20, freshness: 0.15, language: 0.10, region: 0.05, diversity: 0.10 });
  assert.ok(RK.freshness({ updated_at: NOW }, NOW) > RK.freshness({ updated_at: NOW - 30 * DAY }, NOW));
  const a = ST.analyzeQuery('community'); const ctx = { analysis: a, weights: w, now: NOW, langs: ['vi'], region: 'VN' };
  const far = RK.baseScore({ title: '', text: 'community meetup this weekend in Berlin', language: 'de', region: 'DE', updated_at: NOW - DAY }, ctx);
  assert.ok(far.base > 0.3, 'foreign-language / foreign-region result is still ranked (not filtered)');
  const src = require('fs').readFileSync(require.resolve('../src/net/p2p/search-ranking'), 'utf8');
  assert.ok(!/trust|capacity|uptime/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'ranking code never reads node trust/resources');
});
test('ranking: Vietnamese exact-diacritic bonus keeps precision after accent-insensitive recall', () => {
  const a = ST.analyzeQuery('cộng đồng');
  const exact = RK.relevance(a, { title: '', text: 'Cộng đồng yêu thích' }), loose = RK.relevance(a, { title: '', text: 'cong dong yeu thich' });
  assert.ok(exact > loose && loose > 0.5, `${exact} > ${loose}`);
  const a2 = ST.analyzeQuery('cong dong');                                          // user typed without accents: both match equally
  assert.equal(RK.relevance(a2, { title: '', text: 'Cộng đồng yêu thích' }).toFixed(2), RK.relevance(a2, { title: '', text: 'cong dong yeu thich' }).toFixed(2));
});
test('ranking: one big Hub cannot take over a page; cap relaxes only when nothing else matches; dedupe keeps one canonical', () => {
  const mk = (o, n, base) => ({ item: { origin_peer: o, content_id: o + n, updated_at: NOW - n, content_hash: o + n }, base: base - n * 0.001, parts: {} });
  const big = Array.from({ length: 30 }, (_, n) => mk('BIG', n, 0.9)), small = ['A', 'B', 'C', 'D'].flatMap((o) => [0, 1].map((n) => mk(o, n, 0.6)));
  const page = RK.rerank([...big, ...small], 10, { weights: RK.DEFAULT_WEIGHTS, capPerOrigin: 3 });
  assert.ok(page.filter((x) => x.item.origin_peer === 'BIG').length <= 3, 'cap per origin');
  assert.equal(new Set(page.map((x) => x.item.origin_peer)).size, 5);
  assert.equal(RK.rerank(big, 10, { weights: RK.DEFAULT_WEIGHTS, capPerOrigin: 3 }).length, 10, 'cap relaxed when only one origin exists');
  const d = RK.dedupe([{ origin_peer: 'A', content_id: '1', updated_at: 1, content_hash: 'h', text: 'x'.repeat(30), served_by: ['p1'] }, { origin_peer: 'A', content_id: '1', updated_at: 1, content_hash: 'h', text: 'x'.repeat(30), served_by: ['p2'] },
    { origin_peer: 'B', content_id: '9', updated_at: 5, content_hash: 'h', text: 'x'.repeat(30), served_by: ['p3'] }]);
  assert.equal(d.length, 1); assert.deepEqual(d[0].served_by.sort(), ['p1', 'p2']); assert.equal(d[0].duplicates, 1);
});

// ============================================================================================================ the Phase 6 gate
test('GATE: a Vietnamese Hub finds public posts from Japan and Europe without befriending or configuring those Hubs', async (t) => {
  const w = makeWorld(t, WORLD); const [vn, jp, de, fr, vn2] = w.hubs;
  jp.add('今日は東京で友達とコミュニティイベントに参加しました', { id: 'jp-1' });
  jp.add('Tokyo travel guide: best ramen near Shinjuku', { id: 'jp-2', language: 'en' });
  de.add('Visiting Tokyo next month, any tips from the community?', { id: 'de-1' });
  fr.add('Notre communauté parle de cuisine et de voyage à Paris', { id: 'fr-1' });
  vn2.add('Cộng đồng Pi Network Việt Nam chia sẻ kinh nghiệm', { id: 'vn2-1' });
  vn.add('Mình mới đi Tokyo về, rất vui', { id: 'vn-1' });
  await w.start();
  const snap = await vn.fed.search({ q: 'tokyo', limit: 20 });
  const got = ids(snap);
  for (const id of ['jp-1', 'jp-2', 'de-1', 'vn-1']) assert.ok(got.includes(id), id + ' in ' + got);
  assert.ok(!got.includes('fr-1'), 'unrelated post not returned');
  const regions = new Set(snap.items.map((i) => i.region)); assert.ok(regions.has('JP') && regions.has('DE') && regions.has('VN'), [...regions].join());
  const jp1 = snap.items.find((i) => i.content_id === 'jp-1');
  assert.equal(jp1.verified, true); assert.equal(jp1.hub.is_self, false); assert.match(jp1.hub.label, /^JP · hub-[0-9a-f]{4}$/);
  assert.ok(!JSON.stringify(snap.items.map((i) => i.hub)).includes(jp.id), 'UI-facing label never exposes the Peer ID');
  assert.equal(snap.items.find((i) => i.content_id === 'vn-1').hub.label, 'This Hub');
  assert.ok(['complete', 'partial'].includes(snap.state));
  // no friend list / manual configuration anywhere in the request: only the query
  assert.deepEqual(Object.keys({ q: 'tokyo', limit: 20 }), ['q', 'limit']);
});
test('GATE: results are not restricted by language or country — Vietnamese query finds English/Japanese, Japanese query finds Vietnamese/English', async (t) => {
  const w = makeWorld(t, WORLD); const [vn, jp, de] = w.hubs;
  jp.add('コミュニティの集まりは毎週土曜日です', { id: 'jp-c' });
  de.add('Our community meets every Saturday in Berlin', { id: 'de-c' });
  vn.add('Cộng đồng của chúng tôi họp mỗi thứ bảy', { id: 'vn-c' });
  await w.start();
  const vi = ids(await vn.fed.search({ q: 'cộng đồng' })); for (const x of ['vn-c', 'de-c', 'jp-c']) assert.ok(vi.includes(x), 'vi query -> ' + x + ' in ' + vi);
  const noAccent = ids(await vn.fed.search({ q: 'cong dong' })); assert.ok(noAccent.includes('vn-c') && noAccent.includes('de-c'));
  const ja = ids(await jp.fed.search({ q: 'コミュニティ' })); for (const x of ['jp-c', 'de-c', 'vn-c']) assert.ok(ja.includes(x), 'ja query -> ' + x + ' in ' + ja);
  const en = ids(await de.fed.search({ q: 'community' })); for (const x of ['jp-c', 'de-c', 'vn-c']) assert.ok(en.includes(x), 'en query -> ' + x);
});
test('stage order: Local first, then Regional, Language, Topic, Global; region/language only reorder', async (t) => {
  const w = makeWorld(t, WORLD); const [vn, jp, de, fr, vn2] = w.hubs;
  for (const h of [jp, de, fr, vn2]) h.add('Tokyo story number one from ' + h.spec.region, { id: 'x-' + h.i });
  await w.start(); w.net.log.length = 0;
  const snap = await vn.fed.search({ q: 'tokyo', scope: 'global' });
  assert.deepEqual(snap.stages.map((s) => s.stage), ['local', 'regional', 'language', 'topic', 'global']);
  assert.equal(snap.stages[0].state, 'done');
  const order = w.net.log.map((x) => x.to);
  assert.equal(order[0], vn2.id, 'regional peer (same region) is asked first');
  assert.ok(snap.stages.find((s) => s.stage === 'regional').peers === 1);
  assert.ok(snap.sources.queried >= 4 && snap.sources.ok === snap.sources.queried);
  assert.equal(new Set(ids(snap)).size, 4, 'all four remote regions reached');
});

// ============================================================================================================ real social stack
const { EventEmitter } = require('events');
const { Keystore } = require('../src/keystore');
const { Materializer } = require('../src/materializer');
const { Ledger, verifyEnvelope } = require('../src/ledger');
const { PostIndexer, createContentProvider } = require('../src/net/p2p/post-indexer');

/** A real mini Hub data layer: keystore + materializer + signed ledger + posts table (the same code the app runs). */
function attachSocial(hub, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-soc-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bus = new EventEmitter(); const ks = new Keystore(path.join(dir, 'ks'), ''); const mat = new Materializer(hub.db, bus);
  const ledger = new Ledger(hub.db, ks, mat, { warn() {}, info() {}, debug() {} });
  const acct = ks.generate().accountId;
  hub.db.run("INSERT INTO users(username,account_id,status,is_primary) VALUES(?,?,'local',1)", 'user' + hub.i, acct);
  hub.social = { ks, ledger, acct, bus,
    post: (content, o = {}) => ledger.publish(acct, 'post.create', { kind: 'post', content, ...(o.lang ? { lang: o.lang } : {}) }).event_id,
    edit: (id, content) => ledger.publish(acct, 'post.edit', { content }, { target: id }),
    del: (id) => ledger.publish(acct, 'post.delete', {}, { target: id }),
    setVisibility: (id, v) => hub.db.run('UPDATE posts SET visibility=? WHERE event_id=?', v, id) };
  hub.indexer = new PostIndexer({ db: hub.db, index: hub.index, selfId: hub.id, region: hub.spec.region });
  hub.service.isStillPublic = (cid) => hub.indexer.isStillPublic(cid);
  hub.contentProvider = createContentProvider({ db: hub.db });
  hub.verifyEvents = (events) => { let n = 0; for (const e of events) { verifyEnvelope(e); n++; } return n; };
  return hub.social;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================================================ privacy (real posts table)
test('PRIVACY: only public top-level local posts are indexed; edits update, deletes and visibility changes remove (with tombstones)', async (t) => {
  const w = makeWorld(t, WORLD.slice(0, 2)); const [vn, jp] = w.hubs; const soc = attachSocial(jp, t);
  const pub = soc.post('Công khai: đi Tokyo cùng cộng đồng #travel', { lang: 'vi' });
  const toPrivate = soc.post('Bài này sau đó chuyển sang riêng tư SECRETWORD');
  const toDelete = soc.post('Bài này sẽ bị xóa DELETEDWORD');
  const reply = soc.ledger.publish(soc.acct, 'post.create', { kind: 'reply', content: 'REPLYWORD trả lời' }, { parent: pub }).event_id;
  // rows that must never be indexed: followers-only, group, remote-origin (inserted the way the app stores them)
  jp.db.run("INSERT INTO posts(user_id,content,created_at,kind,visibility,sort_ts,origin,event_id) VALUES(1,'FOLLOWERSWORD','x','post','followers',?, 'local','ev1_followers')", Date.now());
  jp.db.run("INSERT INTO posts(group_id,user_id,content,created_at,kind,visibility,sort_ts,origin,event_id) VALUES(1,1,'GROUPWORD','x','post','public',?, 'local','ev1_group')", Date.now());   // even if mislabelled public: group posts are never indexed
  jp.db.run("INSERT INTO posts(user_id,content,created_at,kind,visibility,sort_ts,origin,event_id) VALUES(1,'REMOTEWORD','x','post','public',?, 'remote','ev1_remote')", Date.now());
  jp.indexer.syncAll();
  const q = (word) => jp.index.searchLocal(word).items.length;
  assert.equal(q('tokyo'), 1); assert.equal(q('SECRETWORD'), 1); assert.equal(q('DELETEDWORD'), 1);
  for (const bad of ['REPLYWORD', 'FOLLOWERSWORD', 'GROUPWORD', 'REMOTEWORD']) assert.equal(q(bad), 0, bad + ' must not be indexed');
  const d = jp.index.getDocument(jp.id, pub); assert.equal(d.language, 'vi'); assert.equal(d.region, 'JP'); assert.ok(JSON.parse(d.topics).includes('travel'));
  soc.edit(pub, 'Công khai: đã sửa nội dung EDITEDWORD'); jp.indexer.syncAll();
  assert.equal(q('EDITEDWORD'), 1); assert.equal(q('tokyo'), 0, 'old version no longer searchable');
  soc.del(toDelete); soc.setVisibility(toPrivate, 'followers'); jp.indexer.syncAll();
  assert.equal(q('DELETEDWORD'), 0); assert.equal(q('SECRETWORD'), 0, 'a post that stops being public leaves the index');
  assert.ok(jp.index.getTombstone(jp.id, toDelete), 'deletion leaves a tombstone so replicas cannot resurrect it');
  await w.start();
  const snap = await vn.fed.search({ q: 'SECRETWORD' }); assert.equal(snap.items.length, 0);
});
test('PRIVACY: responder re-checks the source of truth — a stale index entry is never served and is purged', async (t) => {
  const w = makeWorld(t, WORLD.slice(0, 2)); const [vn, jp] = w.hubs;
  jp.add('Tokyo public today', { id: 'will-go-private' }); jp.add('Tokyo stays public', { id: 'stays' });
  await w.start();
  assert.deepEqual(ids(await vn.fed.search({ q: 'tokyo', scope: 'global' })).sort(), ['stays', 'will-go-private']);
  jp.published.set('will-go-private', false);                                          // author makes it private; index was not yet swept
  const s2 = await vn.fed.search({ q: 'tokyo', scope: 'global' }); assert.deepEqual(ids(s2), ['stays']);
  assert.equal(jp.index.getDocument(jp.id, 'will-go-private'), null, 'purged from the origin index');
});
test('PRIVACY: documents that cannot be verified (no origin signature) are never served to other Hubs', async (t) => {
  const w = makeWorld(t, WORLD.slice(0, 2)); const [vn, jp] = w.hubs; await w.start();
  jp.index.upsertDocument({ origin_peer: 'some-remote-peer-without-sig', content_id: 'legacy', visibility: 'public', title: '', text: 'Tokyo legacy unsigned row' }, { verified: true });
  assert.equal(jp.index.searchLocal('legacy').items.length, 1, 'still usable locally');
  assert.equal((await vn.fed.search({ q: 'legacy', scope: 'global' })).items.length, 0);
  const raw = await jp.service.handle(vn.id, { t: 'search', terms: [{ t: 'legacy', w: 1 }] });
  assert.equal(raw.ok, true); assert.equal(raw.items.length, 0, 'the responder itself withholds rows it cannot prove');
});

// ============================================================================================================ content on demand
test('CONTENT: full post is fetched from the ORIGIN, signatures verified, cached, not re-downloaded when unchanged, edits/deletes honoured', async (t) => {
  const w = makeWorld(t, WORLD.slice(0, 2)); const [vn, jp] = w.hubs; const soc = attachSocial(jp, t); attachSocial(vn, t); await w.start();
  const id = soc.post('Bài đầy đủ từ Nhật Bản: nội dung dài hơn phần trích dẫn'); jp.indexer.syncAll();
  const snap = await vn.fed.search({ q: 'nhật bản', scope: 'global' }); const it = snap.items.find((x) => x.content_id === id); assert.ok(it);
  w.net.log.length = 0;
  const r1 = await vn.fed.fetchContent({ origin_ref: it.origin_ref, content_id: id, content_hash: it.content_hash });
  assert.equal(r1.status, 'ok'); assert.equal(r1.post.content, 'Bài đầy đủ từ Nhật Bản: nội dung dài hơn phần trích dẫn'); assert.equal(r1.stale_index, false);
  assert.equal(w.net.log.filter((x) => x.t === 'content').length, 1);
  const r2 = await vn.fed.fetchContent({ origin_ref: it.origin_ref, content_id: id }); assert.equal(r2.cached, true);
  assert.equal(w.net.log.filter((x) => x.t === 'content').length, 1, 'cache hit: no network');
  // TTL expired -> revalidate with the hash; origin answers `unchanged` and nothing is downloaded again
  vn.fed._content.get(it.origin_ref + '\t' + id).at -= 10 * 60000 + 1;
  const r3 = await vn.fed.fetchContent({ origin_ref: it.origin_ref, content_id: id }); assert.equal(r3.unchanged, true);
  assert.equal(w.net.log.filter((x) => x.t === 'content').length, 2);
  // edit at origin -> new hash -> new content + `stale_index` when the search card was older
  soc.edit(id, 'Nội dung đã được chỉnh sửa tại Hub gốc'); vn.fed._content.get(it.origin_ref + '\t' + id).at -= 10 * 60000 + 1;
  const r4 = await vn.fed.fetchContent({ origin_ref: it.origin_ref, content_id: id, content_hash: it.content_hash });
  assert.equal(r4.post.content, 'Nội dung đã được chỉnh sửa tại Hub gốc'); assert.equal(r4.stale_index, true);
  // deletion at origin -> gone, cache cleared
  soc.del(id); vn.fed._content.get(it.origin_ref + '\t' + id).at -= 10 * 60000 + 1;
  assert.equal((await vn.fed.fetchContent({ origin_ref: it.origin_ref, content_id: id })).status, 'gone');
  assert.equal(vn.fed._content.has(it.origin_ref + '\t' + id), false);
});
test('CONTENT: the origin refuses private/followers/group/unknown content; a tampered or foreign-signed reply is rejected', async (t) => {
  const w = makeWorld(t, WORLD.slice(0, 2)); const [vn, jp] = w.hubs; const soc = attachSocial(jp, t); attachSocial(vn, t); await w.start();
  const priv = soc.post('riêng tư'); soc.setVisibility(priv, 'followers');
  const ref = jp.id;
  assert.equal((await vn.fed.fetchContent({ origin_ref: ref, content_id: priv })).status, 'not_found', 'followers-only looks identical to unknown');
  assert.equal((await vn.fed.fetchContent({ origin_ref: ref, content_id: 'ev1_' + '0'.repeat(64) })).status, 'not_found');
  const good = soc.post('bài công khai thật');
  const real = await jp.contentProvider(good); const tampered = JSON.parse(JSON.stringify(real)); tampered.events[0].payload.content = 'FORGED';
  jp.contentProvider = async () => tampered;
  assert.equal((await vn.fed.fetchContent({ origin_ref: ref, content_id: good })).status, 'rejected', 'content altered in transit fails the account signature');
  jp.contentProvider = async () => ({ status: 'ok', events: [real.events[0]] });                                  // genuine event but for a different id
  assert.equal((await vn.fed.fetchContent({ origin_ref: ref, content_id: 'ev1_' + 'a'.repeat(64) })).status, 'not_found');
  assert.equal((await vn.fed.fetchContent({ origin_ref: 'not a peer id', content_id: good })).status, 'bad_request');
  assert.deepEqual(projectPost([{ event_id: 'e1', event_type: 'post.create', actor_id: 'A', payload: { kind: 'post', content: 'x' } }, { event_type: 'post.delete', actor_id: 'B', target: 'e1' }], 'e1').content, 'x', 'a delete by someone else is ignored');
});

// ============================================================================================================ progressive / pagination / explore
test('PROGRESSIVE: local results are readable immediately; remote results arrive later; nothing waits for the whole network', async (t) => {
  const w = makeWorld(t, WORLD.slice(0, 3)); const [vn, jp, de] = w.hubs;
  vn.add('Tokyo local memory', { id: 'vn-local' }); jp.add('Tokyo from Japan', { id: 'jp-1' }); de.add('Tokyo from Germany', { id: 'de-1' });
  await w.start();
  const real = vn.transport.request.bind(vn.transport);
  vn.fed.transport = { request: async (to, msg, o) => { await sleep(to === de.id ? 400 : 120); return real(to, msg, o); } };
  const s = vn.fed.start({ q: 'tokyo', scope: 'global' });
  await sleep(30);
  const early = vn.fed.snapshot(s.id); assert.equal(early.state, 'searching'); assert.deepEqual(ids(early), ['vn-local']);
  assert.equal(early.stages[0].state, 'done');
  await sleep(250); const mid = vn.fed.snapshot(s.id); assert.ok(ids(mid).includes('jp-1') && !ids(mid).includes('de-1'), ids(mid).join());
  await s.done; const fin = vn.fed.snapshot(s.id); assert.deepEqual(ids(fin).sort(), ['de-1', 'jp-1', 'vn-local']); assert.equal(fin.state, 'complete');
  assert.ok(fin.version > early.version);
});
test('PAGINATION + DEDUP: disjoint stable pages, cursor, one card for a document served by several Hubs, per-origin cap per page', async (t) => {
  const w = makeWorld(t, WORLD); const [vn, jp, de, fr, vn2] = w.hubs;
  for (const h of [jp, de, fr, vn2]) for (let i = 0; i < 12; i++) h.add(`Community update number ${i} from ${h.spec.region} about weekly events`, { id: `c-${h.i}-${i}`, ageDays: i });
  const shared = jp.index.getDocument(jp.id, 'c-1-0');                                    // de holds a verified replica of a jp document
  de.index.upsertDocument({ ...shared, text: shared.body, visibility: 'public', topics: JSON.parse(shared.topics) }, { verified: true, originSig: (await jp.service._finish([{ ...shared, text: shared.body, topics: [] }], 1)).items[0].origin_sig });
  await w.start();
  const first = await vn.fed.search({ q: 'community', scope: 'global', limit: 10 });
  assert.equal(first.total, 48); assert.ok(first.next_cursor);
  const sid = first.session, pages = [first.items]; let cursor = first.next_cursor;
  while (cursor) { const c = require('../src/net/p2p/search-ranking').decodeCursor(cursor); const pg = vn.fed.snapshot(sid, { offset: c.o, limit: 10 }); pages.push(pg.items); cursor = pg.next_cursor; }
  const all = pages.flat().map((i) => i.id); assert.equal(all.length, 48); assert.equal(new Set(all).size, 48, 'pages are disjoint, nothing lost');
  for (const pg of pages.slice(0, -1)) { const per = {}; for (const i of pg) per[i.hub.label] = (per[i.hub.label] || 0) + 1; assert.ok(Math.max(...Object.values(per)) <= 3, 'cap per origin per page: ' + JSON.stringify(per)); }
  const again = vn.fed.snapshot(sid, { offset: 0, limit: 10 }); assert.deepEqual(again.items.map((i) => i.id), first.items.map((i) => i.id), 'stable for the same session');
  const dup = pages.flat().find((i) => i.content_id === 'c-1-0'); assert.equal(dup.sources, 2, 'served by origin and by a replica, shown once');
});
test('EXPLORE browse mode: no query -> newest public posts across Hubs; strict filters (language / region / topic) are explicit user choices', async (t) => {
  const w = makeWorld(t, WORLD.slice(0, 4)); const [vn, jp, de, fr] = w.hubs;
  jp.add('今日の料理はとても美味しかった', { id: 'jp-food', ageDays: 1 }); jp.add('東京のニュース', { id: 'jp-news', ageDays: 20 });
  de.add('New technology meetup in Berlin this week', { id: 'de-tech', ageDays: 2 }); fr.add('La cuisine française est délicieuse et simple', { id: 'fr-food', ageDays: 3 });
  vn.add('Hôm nay Hà Nội trời đẹp lắm các bạn ơi', { id: 'vn-1', ageDays: 4 }); await w.start();
  const all = await vn.fed.search({ q: '', scope: 'global', limit: 10 }); assert.equal(all.mode, 'browse');
  assert.equal(all.total, 5); assert.equal(ids(all)[4], 'jp-news', 'the 20-day-old post ranks last (freshness), but language/region only reorder: nothing is dropped');
  assert.deepEqual(ids(await vn.fed.search({ q: '', scope: 'global', region: 'JP' })).sort(), ['jp-food', 'jp-news']);
  assert.deepEqual(ids(await vn.fed.search({ q: '', scope: 'global', language: 'fr' })), ['fr-food']);
  const food = ids(await vn.fed.search({ q: '', scope: 'global', topic: 'food' })).sort(); assert.deepEqual(food, ['fr-food', 'jp-food']);
  const q = ids(await vn.fed.search({ q: 'cuisine', scope: 'global' })); assert.ok(q.includes('fr-food') && q.includes('jp-food'), 'cuisine ~ 料理 ~ food: ' + q);
});

// ============================================================================================================ security
test('SECURITY: forged / tampered / malformed remote results are dropped, only honest ones shown, forger is reported to trust', async (t) => {
  const seen = []; const spy = { stateOf: () => 'TRUSTED', allow: () => ({ ok: true }), observe: (p, o) => seen.push([p, o]) };
  const w = makeWorld(t, WORLD.slice(0, 3), { trust: spy }); const [vn, jp, evil] = w.hubs;
  jp.add('Tokyo honest post from Japan', { id: 'jp-ok' });
  const own = (text, id, extra = {}) => { const d = { origin_peer: evil.id, content_id: id, title: '', text, language: 'en', region: 'US', topics: [], updated_at: NOW - DAY, ...extra }; d.content_hash = C.sha256(d.title + '\n' + d.text); return d; };
  const sign = async (d, who = evil) => ({ ...d, origin_sig: await who.signer.sign(C.docPayload(d)) });
  const honestOwn = await sign(own('Tokyo evil but honestly signed own post', 'evil-own'));
  const impersonate = await sign({ ...own('Tokyo fake news pretending to be Japan', 'fake-1'), origin_peer: jp.id });           // signed by evil, claims jp
  const tampered = { ...await sign(own('Tokyo original text', 'tam-1')), text: 'Tokyo TAMPERED text' };                          // hash no longer matches
  const future = await sign(own('Tokyo from the far future', 'fut-1', { updated_at: Date.now() + 365 * DAY }));
  const badId = await sign({ ...own('Tokyo bad peer id', 'x'), origin_peer: '../../etc/passwd' });
  const huge = await sign(own('Tokyo ' + 'a'.repeat(50000), 'huge-1'));
  evil.transport.start(async () => ({ ok: true, items: [honestOwn, impersonate, tampered, future, badId, huge, null, 'str', 42] }));
  await jp.transport.start((f, m) => jp.service.handle(f, m)); await vn.transport.start((f, m) => vn.service.handle(f, m));
  const snap = await vn.fed.search({ q: 'tokyo', scope: 'global' }); const got = ids(snap).sort();
  assert.deepEqual(got, ['evil-own', 'jp-ok'], 'a Hub may publish its OWN signed content; nothing else it sends survives: ' + got);
  assert.ok(snap.sources.rejected_items >= 4);
  assert.ok(seen.some(([p, o]) => p === evil.id && o.abuse === 1), 'forger reported'); assert.ok(seen.some(([p, o]) => p === jp.id && o.success), 'honest peer credited');
  assert.ok(!seen.some(([p, o]) => p === jp.id && o.abuse), 'honest peer never penalised');
  const rejects = await vn.fed.search({ q: 'tokyo honest', scope: 'global', want: 5 }); assert.ok(rejects.items.every((i) => i.verified));
});
test('SECURITY: flooding — per-peer rate limits, backpressure, cost budgets; honest peers unaffected; blocked/quarantined refused', async (t) => {
  const te = new TrustEngine(); const w = makeWorld(t, WORLD.slice(0, 3), { trust: te }); const [vn, jp, de] = w.hubs;
  jp.add('Tokyo post to search', { id: 'p1' }); await w.start();
  for (const h of [vn, jp, de]) for (const x of w.hubs) for (let i = 0; i < 6; i++) te.observe(x.id, { success: true });
  const flood = []; for (let i = 0; i < 300; i++) flood.push(await jp.service.handle(de.id, { t: 'search', terms: [{ t: 'tokyo', w: 1 }], limit: 5 }));
  const limited = flood.filter((r) => r.reason === 'rate_limited').length; assert.ok(limited > 150, 'flood limited: ' + limited);
  assert.equal((await jp.service.handle(vn.id, { t: 'search', terms: [{ t: 'tokyo', w: 1 }], limit: 5 })).ok, true, 'a different honest peer is unaffected');
  // budgets: absurd terms/limit are capped, never crash, never return more than the cap
  const big = await jp.service.handle(vn.id, { t: 'search', terms: Array.from({ length: 5000 }, (_, i) => ({ t: 'w' + i, w: 1 })).concat([{ t: 'tokyo', w: 1 }]), limit: 1e9 });
  assert.ok(big.ok === false ? ['rate_limited', 'no_terms'].includes(big.reason) : big.items.length <= 30);
  assert.equal((await jp.service.handle(vn.id, { t: 'search', terms: [{ t: 'x'.repeat(500), w: 1 }] })).reason, 'no_terms', 'over-long term rejected');
  assert.equal((await jp.service.handle(vn.id, { t: 'nope' })).reason, 'bad_message'); assert.equal((await jp.service.handle(vn.id, null)).reason, 'bad_message');
  te.block(de.id, 'test'); assert.equal((await jp.service.handle(de.id, { t: 'search', terms: [{ t: 'tokyo', w: 1 }] })).reason, 'trust_blocked');
  te.quarantine(vn.id, 'test'); assert.equal((await jp.service.handle(vn.id, { t: 'browse' })).reason, 'trust_quarantined');
  // NEW peers get a smaller budget than TRUSTED ones
  const te2 = new TrustEngine(); const svc = new SearchService({ index: jp.index, signer: jp.signer, selfId: jp.id, trust: te2, governor: jp.governor });
  let newOk = 0; for (let i = 0; i < 40; i++) if ((await svc.handle('N'.repeat(44), { t: 'search', terms: [{ t: 'tokyo', w: 1 }] })).ok) newOk++;
  assert.ok(newOk < 30, 'NEW peer budget is reduced: ' + newOk);
});
test('SECURITY: backpressure when the Hub is busy or under CPU pressure; Hub keeps serving afterwards', async (t) => {
  const w = makeWorld(t, WORLD.slice(0, 2), { cfg: { service: { rateBurst: 1000, ratePerSec: 1000 } } }); const [vn, jp] = w.hubs; jp.add('Tokyo busy test', { id: 'b1' });
  jp.governor.overrides = { baseConcurrency: 1 };                                                          // limit = max(2, 2) = 2 in-flight
  const slowSign = jp.signer.sign.bind(jp.signer); jp.signer.sign = async (x) => { await sleep(40); return slowSign(x); };
  const burst = await Promise.all(Array.from({ length: 12 }, () => jp.service.handle(vn.id, { t: 'search', terms: [{ t: 'tokyo', w: 1 }] })));
  assert.ok(burst.some((r) => r.reason === 'busy'), 'busy responses'); assert.ok(burst.some((r) => r.ok), 'some served');
  jp.signer.sign = slowSign; jp.governor.p.load1 = () => 7.9;                                              // CPU pressure: shed searches, keep content reads
  assert.equal((await jp.service.handle(vn.id, { t: 'search', terms: [{ t: 'tokyo', w: 1 }] })).reason, 'busy');
  jp.governor.p.load1 = () => 0.1; await sleep(5); assert.equal((await jp.service.handle(vn.id, { t: 'search', terms: [{ t: 'tokyo', w: 1 }] })).ok, true);
});
test('SECURITY: bounded fan-out and no URL fetching — 40 known Hubs never cause more than maxPeers requests; module has no http/dns/net access', async (t) => {
  const specs = Array.from({ length: 41 }, (_, i) => ({ region: i === 0 ? 'VN' : ['JP', 'DE', 'FR', 'US'][i % 4], languages: ['en'] }));
  const w = makeWorld(t, specs); const [vn, ...rest] = w.hubs; for (const h of rest) h.add('Tokyo post ' + h.i, { id: 'k' + h.i }); await w.start(); w.net.log.length = 0;
  const snap = await vn.fed.search({ q: 'tokyo', scope: 'global', limit: 50 });
  assert.ok(snap.sources.queried <= 24, 'queried ' + snap.sources.queried); assert.equal(w.net.log.length, snap.sources.queried);
  for (const st of snap.stages.slice(1)) assert.ok(st.peers <= 6 + 2, st.stage + ' peers ' + st.peers);
  for (const f of ['federated-search', 'search-text', 'search-ranking', 'post-indexer']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'net', 'p2p', f + '.js'), 'utf8');
    assert.ok(!/require\(['"](https?|net|dns|tls|child_process|dgram)['"]\)|\bfetch\(/.test(src), f + ' must not open sockets / fetch URLs (SSRF)');
  }
});
test('SESSIONS: per-user concurrency cap, session cap, result cache (TTL) and cancel', async (t) => {
  const clock = { t: 1000 }; const w = makeWorld(t, WORLD.slice(0, 3), { clock, cfg: { fed: { maxPerUser: 2, cacheTtlMs: 30000, maxSessions: 5 } } }); const [vn, jp, de] = w.hubs;
  jp.add('Tokyo cache test', { id: 'c1' }); await w.start();
  const real = vn.transport.request.bind(vn.transport); vn.fed.transport = { request: async (to, m, o) => { await sleep(150); return real(to, m, o); } };
  const a = vn.fed.start({ q: 'one tokyo', user: 'u1', scope: 'global' }), b = vn.fed.start({ q: 'two tokyo', user: 'u1', scope: 'global' });
  assert.throws(() => vn.fed.start({ q: 'three tokyo', user: 'u1' }), (e) => e.code === 'E_BUSY');
  vn.fed.start({ q: 'other user', user: 'u2' }).done; vn.fed.cancel(a.id); await Promise.all([a.done, b.done]);
  assert.equal(vn.fed.snapshot(a.id).state, 'cancelled');
  vn.fed.transport = { request: real };
  const s1 = await vn.fed.search({ q: 'tokyo cache', user: 'u3' }); w.net.log.length = 0;
  const s2 = await vn.fed.search({ q: 'tokyo cache', user: 'u3' }); assert.equal(s2.cached, true); assert.equal(w.net.log.length, 0, 'served from cache, no network');
  clock.t += 31000; w.net.log.length = 0; const s3 = await vn.fed.search({ q: 'tokyo cache', user: 'u3' }); assert.equal(s3.cached, false); assert.ok(w.net.log.length > 0, 'TTL expired -> refreshed');
  for (let i = 0; i < 12; i++) await vn.fed.search({ q: 'q' + i + ' tokyo', user: 'g' + i });
  assert.ok(vn.fed._sessions.size <= 6, 'sessions bounded: ' + vn.fed._sessions.size);
});

// ============================================================================================================ resilience
test('RESILIENCE: an offline Hub yields a partial result with the rest intact; replacement / later stages still reach every live Hub', async (t) => {
  const w = makeWorld(t, [WORLD[0], WORLD[1], WORLD[2], WORLD[4]], { cfg: { fed: { fanout: 1, replacements: 2 } } }); const [vn, jp, de, vn2] = w.hubs;
  for (const h of [jp, de, vn2]) h.add('Community news ' + h.spec.region, { id: 'n' + h.i }); await w.start();
  w.net.setDown(de.id);
  const snap = await vn.fed.search({ q: 'community', scope: 'global' });
  assert.equal(snap.state, 'partial'); assert.ok(snap.sources.failed >= 1);
  assert.deepEqual(ids(snap).sort(), ['n1', 'n3'], 'everything reachable is returned although fan-out per stage is 1');
});
test('RESILIENCE: circuit breaker skips a dead Hub after repeated failures, probes again after the back-off, no retry storm', async (t) => {
  const clock = { t: 1000 }; const w = makeWorld(t, WORLD.slice(0, 3), { clock, cfg: { fed: { cacheTtlMs: 0, breakerFails: 3, breakerBaseMs: 15000 } } }); const [vn, jp, de] = w.hubs;
  jp.add('Tokyo alive', { id: 'ok' }); await w.start(); w.net.setDown(de.id);
  for (let i = 0; i < 3; i++) await vn.fed.search({ q: 'tokyo q' + i, scope: 'global' });
  assert.equal(vn.fed._isOpen(de.id), true); w.net.log.length = 0;
  const s = await vn.fed.search({ q: 'tokyo again', scope: 'global' });
  assert.equal(w.net.log.filter((x) => x.to === de.id).length, 0, 'open breaker: no request to the dead Hub'); assert.ok(s.sources.skipped_open >= 1); assert.deepEqual(ids(s), ['ok']);
  clock.t += 120000; w.net.setDown(de.id, false); de.add('Tokyo recovered', { id: 'back' });
  const s2 = await vn.fed.search({ q: 'tokyo recovered', scope: 'global' }); assert.ok(ids(s2).includes('back'), 'half-open probe succeeded'); assert.equal(vn.fed._isOpen(de.id), false);
});
test('RESILIENCE: a hanging Hub cannot stall the search past the stage/total timeouts; all-remote-down degrades to local results; no network = offline state', async (t) => {
  const w = makeWorld(t, WORLD.slice(0, 3), { cfg: { fed: { stageTimeoutMs: 300, totalTimeoutMs: 1500 } } }); const [vn, jp, de] = w.hubs;
  vn.add('Tokyo local', { id: 'loc' }); jp.add('Tokyo jp', { id: 'jp' }); de.add('Tokyo de', { id: 'de' });
  await vn.transport.start((f, m) => vn.service.handle(f, m)); await jp.transport.start((f, m) => jp.service.handle(f, m)); await de.transport.start(() => new Promise(() => {}));   // de never answers
  const t0 = Date.now(); const snap = await vn.fed.search({ q: 'tokyo', scope: 'global' }); const took = Date.now() - t0;
  assert.ok(took < 1800, 'bounded: ' + took); assert.deepEqual(ids(snap).sort(), ['jp', 'loc']); assert.equal(snap.state, 'partial');
  w.net.setDown(jp.id); w.net.setDown(de.id); vn.fed._health.clear(); vn.fed._cache.clear();
  const down = await vn.fed.search({ q: 'tokyo down', scope: 'global' }); assert.equal(down.state, 'degraded'); assert.deepEqual(ids(down), ['loc'], 'local results survive total remote loss');
  const down2 = await vn.fed.search({ q: 'tokyo', scope: 'global' }); assert.equal(down2.state, 'degraded');
  const lonely = makeWorld(t, [{ region: 'VN', languages: ['vi'] }]); lonely.hubs[0].add('Tokyo only me', { id: 'me' });
  const solo = await lonely.hubs[0].fed.search({ q: 'tokyo' }); assert.equal(solo.state, 'local_only'); assert.deepEqual(ids(solo), ['me']);
  const empty = await makeWorld(t, [{ region: 'VN', languages: ['vi'] }]).hubs[0].fed.search({ q: 'nothing' }); assert.equal(empty.state, 'offline');
});
test('RESILIENCE: scope=auto stops expanding once results are plentiful and diverse (cost), scope=global always goes the whole way', async (t) => {
  const specs = [{ region: 'VN', languages: ['vi'] }, { region: 'VN', languages: ['vi'] }, { region: 'VN', languages: ['vi'] }, { region: 'JP', languages: ['ja'] }, { region: 'DE', languages: ['de'] }];
  const w = makeWorld(t, specs); const [vn, vn2, vn3, jp, de] = w.hubs;
  for (const h of [vn, vn2, vn3]) for (let i = 0; i < 8; i++) h.add('Community weekly update ' + i + ' ' + h.i, { id: `a${h.i}-${i}`, region: i === 0 && h !== vn ? 'JP' : undefined });
  for (const h of [jp, de]) for (let i = 0; i < 4; i++) h.add('Community weekly update ' + i + ' ' + h.spec.region, { id: `b${h.i}-${i}` });
  await w.start(); w.net.log.length = 0;
  const auto = await vn.fed.search({ q: 'community', scope: 'auto', limit: 20 });
  assert.equal(auto.stages.find((s) => s.stage === 'regional').state, 'done');
  assert.ok(auto.stages.slice(2).every((s) => s.state === 'skipped'), JSON.stringify(auto.stages.map((s) => [s.stage, s.state, s.reason])));
  assert.ok(!w.net.log.some((x) => x.to === jp.id || x.to === de.id), 'far Hubs are not even contacted when the region already satisfied the query');
  vn.fed._cache.clear(); const glob = await vn.fed.search({ q: 'community', scope: 'global', limit: 20 });
  assert.ok(glob.total > auto.total, 'global reaches Japan/Europe too'); assert.ok(glob.sources.queried > auto.sources.queried);
});
test('RESOURCE: concurrency adapts to load and tier; weak machines keep fan-out small', async (t) => {
  const w = makeWorld(t, WORLD.slice(0, 4)); const [vn, jp, de, fr] = w.hubs; for (const h of [jp, de, fr]) h.add('Tokyo x ' + h.i, { id: 'r' + h.i }); await w.start();
  vn.governor.p.cpus = () => 1; vn.governor.p.load1 = () => 0.95; vn.governor.p.totalMemMb = () => 1000;      // weak + loaded
  const peak = { n: 0, cur: 0 }; const real = vn.transport.request.bind(vn.transport);
  vn.fed.transport = { request: async (to, m, o) => { peak.cur++; peak.n = Math.max(peak.n, peak.cur); await sleep(30); try { return await real(to, m, o); } finally { peak.cur--; } } };
  const snap = await vn.fed.search({ q: 'tokyo', scope: 'global' }); assert.equal(snap.total, 3); assert.ok(peak.n <= Math.max(2, vn.governor.concurrency()), 'peak ' + peak.n);
  assert.ok(vn.governor.concurrency() <= 2);
});

// ============================================================================================================ HTTP API on a real Hub
const { startHub, Client } = require('./helpers');
test('API: /api/explore/network requires login, validates input, owns its sessions, finds own + remote public posts, serves content on demand', async (t) => {
  const hub = await startHub({ allowRegistration: true, rateLimit: { general: 1e5, write: 1e5, login: 1e4, upload: 100, federation: 100, assistant: 20 } });
  t.after(() => hub.stop());
  const owner = new Client(hub.base); await owner.setup('owner');
  assert.equal((await new Client(hub.base).get('/api/explore/network?q=tokyo')).status, 401, 'login required');
  assert.equal((await owner.get('/api/explore/network?q=tokyo')).json.state, 'unavailable', 'no network engine -> explicit state, not an error');
  // a "remote" Japanese Hub on a loopback network + the REAL hub db/ledger/posts as the local side
  const net = new LoopbackNetwork(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-api-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jpSigner = C.createEd25519Signer(); const jpDb = openDatabase(path.join(dir, 'jp.sqlite')); t.after(() => jpDb.close());
  const jpIndex = new DistributedIndex({ db: jpDb, localPeerId: () => jpSigner.peerId }); const jpSvc = new SearchService({ index: jpIndex, signer: jpSigner, selfId: jpSigner.peerId, trust: trustAll });
  const jpHub = { id: jpSigner.peerId, i: 9, db: jpDb, index: jpIndex, spec: { region: 'JP', languages: ['ja'] }, service: jpSvc }; const jpSoc = attachSocial(jpHub, t); jpSvc.contentProvider = jpHub.contentProvider; jpSvc.isStillPublic = (c) => jpHub.indexer.isStillPublic(c);
  const jpPost = jpSoc.post('東京のコミュニティイベントのお知らせ #tokyo', { lang: 'ja' }); jpHub.indexer.syncAll();
  await net.attach(jpSigner.peerId).start((f, m) => jpSvc.handle(f, m));
  const mySigner = C.createEd25519Signer(); const myIndex = new DistributedIndex({ db: hub.db, localPeerId: () => mySigner.peerId });
  const myTransport = net.attach(mySigner.peerId); const mySvc = new SearchService({ index: myIndex, signer: mySigner, selfId: mySigner.peerId, trust: trustAll }); await myTransport.start((f, m) => mySvc.handle(f, m));
  const indexer = new PostIndexer({ db: hub.db, index: myIndex, selfId: mySigner.peerId, region: 'VN' });
  const fed = new FederatedSearch({ index: myIndex, transport: myTransport, signer: mySigner, selfId: mySigner.peerId, trust: trustAll, profile: { region: 'VN', languages: ['vi'] },
    peers: () => [{ peer_id: jpSigner.peerId, region: 'JP', languages: ['ja'], topics: [] }], verifyEvents: (evs) => { let n = 0; for (const e of evs) { verifyEnvelope(e); n++; } return n; } });
  hub.net = { federatedSearch: fed };
  await owner.post('/api/posts', { content: 'Hôm nay mình đi Tokyo, rất vui' });
  await owner.post('/api/posts', { content: 'Bài chỉ cho người theo dõi FOLLOWERONLY Tokyo', visibility: 'followers' });
  indexer.syncAll();
  const first = await owner.get('/api/explore/network?q=' + encodeURIComponent('tokyo') + '&scope=global');
  assert.equal(first.status, 200); const sid = first.json.session; assert.ok(sid);
  const done = await owner.get('/api/explore/network?session=' + sid + '&limit=20'); const items = done.json.items;
  assert.ok(items.some((i) => i.content_id === jpPost && i.hub.region === 'JP'), 'Japanese post found through the API without befriending anyone');
  assert.ok(items.some((i) => i.hub.is_self), 'own public post found'); assert.ok(!JSON.stringify(done.json).includes('FOLLOWERONLY'), 'followers-only post never leaves the Hub');
  assert.ok(!JSON.stringify(done.json).includes('"origin_peer"') && !JSON.stringify(items.map((i) => i.hub)).includes(jpSigner.peerId), 'no Peer ID in display fields');
  const other = new Client(hub.base); await owner.post('/api/admin/users', { username: 'bob', password: 'correct-horse-9' }).catch(() => {}); 
  await other.post('/api/register', { username: 'bob', password: 'correct-horse-9' }); await other.login('bob');
  assert.equal((await other.get('/api/explore/network?session=' + sid)).status, 404, 'a session belongs to its creator');
  assert.equal((await owner.get('/api/explore/network?session=nope')).status, 404);
  assert.equal((await owner.get('/api/explore/network?q=tokyo&language=<script>&region=zzz&topic=%27;--&scope=evil')).status, 200, 'bad filters are ignored, not echoed');
  const it = items.find((i) => i.content_id === jpPost);
  const full = await owner.get('/api/explore/network/post?origin=' + it.origin_ref + '&id=' + encodeURIComponent(jpPost) + '&hash=' + it.content_hash);
  assert.equal(full.status, 200); assert.match(full.json.post.content, /東京のコミュニティ/);
  assert.equal((await owner.get('/api/explore/network/post?origin=bad&id=x')).status, 400);
  jpSoc.del(jpPost); jpHub.indexer.syncAll(); fed._content.clear();
  assert.equal((await owner.get('/api/explore/network/post?origin=' + it.origin_ref + '&id=' + encodeURIComponent(jpPost))).status, 410);
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'views.js'), 'utf8');
  assert.ok(!/innerHTML\s*=/.test(ui.slice(ui.indexOf('function networkExplore'), ui.indexOf('async function viewExplore'))), 'remote text is rendered with textContent only');
});

// ============================================================================================================ multi-process simulation
test('MULTI-PROCESS SIMULATION (real TCP, 5 OS processes VN/VN/JP/DE/FR): cross-region discovery, then one source is killed -9 mid-session', { timeout: 120000 }, async (t) => {
  const { fork } = require('child_process'); const procs = []; let seq = 0; const waiters = new Map();
  const spawn = () => { const p = fork(path.join(__dirname, 'helpers', 'search-node-proc.js'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }); p.on('message', (m) => { const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m.v); } }); procs.push(p); return p; };
  const call = (p, msg) => new Promise((res, rej) => { const id = ++seq; const to = setTimeout(() => { waiters.delete(id); rej(new Error('ipc timeout ' + msg.cmd)); }, 15000); waiters.set(id, (v) => { clearTimeout(to); res(v); }); p.send({ id, ...msg }); });
  t.after(() => { for (const p of procs) { try { p.kill('SIGKILL'); } catch {} } });
  const specs = [['VN', ['vi', 'en']], ['VN', ['vi']], ['JP', ['ja', 'en']], ['DE', ['de', 'en']], ['FR', ['fr', 'en']]];
  const nodes = specs.map(() => spawn()); const info = [];
  for (let i = 0; i < nodes.length; i++) info.push(await call(nodes[i], { cmd: 'init', region: specs[i][0], languages: specs[i][1] }));
  const dirMap = Object.fromEntries(info.map((x) => [x.id, x.port])); const hints = info.map((x, i) => ({ peer_id: x.id, region: specs[i][0], languages: specs[i][1], topics: [] }));
  for (const p of nodes) await call(p, { cmd: 'dir', dir: dirMap, hints });
  await call(nodes[1], { cmd: 'add', cid: 'vn2-1', text: 'Cộng đồng Pi Network Việt Nam họp mặt tại Tokyo', region: 'VN' });
  await call(nodes[2], { cmd: 'add', cid: 'jp-1', text: '東京でコミュニティの集まりがありました', region: 'JP' });
  await call(nodes[2], { cmd: 'add', cid: 'jp-2', text: 'Tokyo ramen guide for visitors', region: 'JP' });
  await call(nodes[3], { cmd: 'add', cid: 'de-1', text: 'Planning a trip to Tokyo with our community', region: 'DE' });
  await call(nodes[4], { cmd: 'add', cid: 'fr-1', text: 'Notre communauté parle de Tokyo et de cuisine', region: 'FR' });
  const r1 = await call(nodes[0], { cmd: 'search', q: 'tokyo' });
  for (const id of ['vn2-1', 'jp-1', 'jp-2', 'de-1', 'fr-1']) assert.ok(r1.ids.includes(id), id + ' in ' + r1.ids);
  assert.ok(['VN', 'JP', 'DE', 'FR'].every((x) => r1.regions.includes(x)), r1.regions.join()); assert.equal(r1.state, 'complete');
  const jpOnly = await call(nodes[2], { cmd: 'search', q: 'cộng đồng' }); for (const id of ['vn2-1', 'jp-1', 'de-1', 'fr-1']) assert.ok(jpOnly.ids.includes(id), 'JP hub, vi query -> ' + id + ': ' + jpOnly.ids);
  nodes[3].kill('SIGKILL');                                                           // the German Hub dies hard
  const r2 = await call(nodes[0], { cmd: 'search', q: 'tokyo trip', scope: 'global' });
  assert.ok(!r2.ids.includes('de-1') && r2.ids.includes('jp-2') && r2.ids.includes('fr-1'), r2.ids.join()); assert.equal(r2.state, 'partial'); assert.ok(r2.sources.failed >= 1);
});
