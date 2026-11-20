'use strict';
// Benchmark (in-process loopback: measures CPU / SQLite / ranking cost, NOT network latency).  node scripts/federated-search-bench.js [docsPerHub]
const fs = require('fs'), os = require('os'), path = require('path');
const { openDatabase } = require('../src/db');
const { DistributedIndex } = require('../src/net/p2p/distributed-index');
const { SearchService, FederatedSearch } = require('../src/net/p2p/federated-search');
const { ResourceGovernor, LoopbackNetwork } = require('../src/net/p2p/index-governor');
const ST = require('../src/net/p2p/search-text'); const C = require('../src/net/p2p/index-crypto');
const N = Number(process.argv[2] || 5000); const trust = { stateOf: () => 'TRUSTED', allow: () => ({ ok: true }), observe() {} };
const VI = ['cộng đồng', 'Việt Nam', 'chia sẻ', 'kinh nghiệm', 'du lịch', 'ẩm thực', 'công nghệ', 'âm nhạc', 'giáo dục', 'sức khỏe', 'tài chính', 'thể thao', 'bạn bè', 'hình ảnh', 'việc làm'];
const EN = ['community', 'travel', 'food', 'technology', 'music', 'education', 'health', 'finance', 'sports', 'friends', 'photos', 'jobs', 'meetup', 'weekly', 'update'];
const JA = ['東京', 'コミュニティ', '料理', '旅行', '音楽', '教育', '健康', '友達', 'ニュース', '写真', '仕事', 'イベント'];
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296; const pick = (a) => a[Math.floor(rnd() * a.length)];
const doc = (lang) => { const w = lang === 'vi' ? VI : lang === 'en' ? EN : JA; const n = 8 + Math.floor(rnd() * 14); return Array.from({ length: n }, () => pick(w)).join(lang === 'ja' ? '' : ' ') + (lang === 'ja' ? 'です' : ' ' + Math.floor(rnd() * 1e6)); };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return +(s[Math.min(s.length - 1, Math.floor(p * s.length))]).toFixed(2); };
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-bench-')); const net = new LoopbackNetwork(); const hubs = [];
  for (const [i, [region, lang]] of [['VN', 'vi'], ['JP', 'ja'], ['DE', 'en']].entries()) {
    const sg = C.createEd25519Signer(); const db = openDatabase(path.join(dir, i + '.sqlite')); const index = new DistributedIndex({ db, localPeerId: () => sg.peerId, maxDocuments: 1e6, maxBytes: 1e9 });
    const gov = new ResourceGovernor({ index, probes: { load1: () => 0.1, cpus: () => 8, totalMemMb: () => 16000, rssMb: () => 100, freeDiskMb: () => 1e6 } });
    hubs.push({ sg, db, index, region, lang, gov, file: path.join(dir, i + '.sqlite'), tr: net.attach(sg.peerId), svc: new SearchService({ index, signer: sg, selfId: sg.peerId, trust, governor: gov, config: { rateBurst: 1e6, ratePerSec: 1e6 } }) });
  }
  const t0 = process.hrtime.bigint();
  for (const h of hubs) for (let i = 0; i < N; i++) h.index.upsertDocument({ origin_peer: h.sg.peerId, content_id: 'p' + i, visibility: 'public', title: '', text: doc(h.lang), language: h.lang, region: h.region, updated_at: Date.now() - Math.floor(rnd() * 90) * 86400000 }, { local: true });
  const idxMs = Number(process.hrtime.bigint() - t0) / 1e6; const total = N * hubs.length;
  const sz = (h) => fs.statSync(h.file).size + (fs.existsSync(h.file + '-wal') ? fs.statSync(h.file + '-wal').size : 0);
  const out = { docs_per_hub: N, index_docs_per_sec: Math.round(total / (idxMs / 1000)), disk_mb_per_hub: hubs.map((h) => +(sz(h) / 1048576).toFixed(1)), terms_per_doc: hubs.map((h) => +(h.db.get('SELECT COUNT(*) c FROM p2p_index_terms').c / N).toFixed(1)) };
  for (const h of hubs) await h.tr.start((f, m) => h.svc.handle(f, m));
  const [vn, jp, de] = hubs; const peers = () => hubs.filter((x) => x !== vn).map((x) => ({ peer_id: x.sg.peerId, region: x.region, languages: [x.lang], topics: [] }));
  const fed = new FederatedSearch({ index: vn.index, transport: vn.tr, signer: vn.sg, selfId: vn.sg.peerId, trust, governor: vn.gov, profile: { region: 'VN', languages: ['vi', 'en'] }, peers, config: { cacheTtlMs: 0, stageTimeoutMs: 5000, totalTimeoutMs: 15000 } });
  const queries = ['cộng đồng', 'cong dong', 'community', 'コミュニティ', 'du lịch', 'travel', '料理', 'tokyo', 'âm nhạc music', 'ẩm thực'];
  const local = [], fedMs = [], respBytes = []; let checks = 0, same = 0;
  for (let r = 0; r < 20; r++) for (const q of queries) {
    let a = process.hrtime.bigint(); vn.index.searchWeighted(ST.analyzeQuery(q).terms, { limit: 30 }); local.push(Number(process.hrtime.bigint() - a) / 1e6);
    a = process.hrtime.bigint(); const s = await fed.search({ q, scope: 'global', limit: 20 }); fedMs.push(Number(process.hrtime.bigint() - a) / 1e6); respBytes.push(JSON.stringify(s).length);
  }
  for (const [acc, plain] of [['cộng đồng', 'cong dong'], ['du lịch', 'du lich'], ['ẩm thực', 'am thuc'], ['âm nhạc', 'am nhac'], ['sức khỏe', 'suc khoe']]) { const A = (await fed.search({ q: acc, scope: 'local', limit: 20 })).items.map((i) => i.content_id), B = (await fed.search({ q: plain, scope: 'local', limit: 20 })).items.map((i) => i.content_id); checks++; if (A.join() === B.join() || A.filter((x) => B.includes(x)).length >= 18) same++; }
  out.local_search_ms = { p50: pct(local, 0.5), p95: pct(local, 0.95) }; out.federated_3hub_ms = { p50: pct(fedMs, 0.5), p95: pct(fedMs, 0.95) }; out.response_kb_p50 = +(pct(respBytes, 0.5) / 1024).toFixed(1);
  out.vi_accent_vs_plain_top20_overlap_ge90pct = `${same}/${checks}`; out.rss_mb = Math.round(process.memoryUsage().rss / 1048576);
  console.log(JSON.stringify(out, null, 1)); for (const h of hubs) h.db.close(); fs.rmSync(dir, { recursive: true, force: true });
})();
