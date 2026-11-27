'use strict';
// Runs INSIDE a memory-limited child process (node --max-old-space-size=N). Prints one JSON line. Exit 0 = no OOM / crash.
const { startHub, Client } = require('../helpers');
const { DistributedIndex } = require('../../src/net/p2p/distributed-index');
const { PostIndexer } = require('../../src/net/p2p/post-indexer');
const { HealingSupervisor } = require('../../src/net/p2p/self-healing');
const POSTS = Number(process.env.PROBE_POSTS || 3000); const CONC = Number(process.env.PROBE_CONC || 40); const ROUNDS = Number(process.env.PROBE_ROUNDS || 6);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };
(async () => {
  const out = { posts: POSTS, heap_limit_mb: Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576) }; let peak = 0; const lag = []; let last = Date.now();
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 100); const loop = setInterval(() => { const n = Date.now(); lag.push(Math.max(0, n - last - 20)); last = n; }, 20);
  out.idle_rss_mb = Math.round(process.memoryUsage().rss / 1048576);
  const hub = await startHub({ allowRegistration: true, rateLimit: { general: 1e6, write: 1e6, login: 1e5, upload: 1e4, federation: 1e6, assistant: 50 }, healing: { intervalMs: 0, cycleBudgetMs: 2000 } });
  const c = new Client(hub.base); await c.setup('owner', 'correct-horse-9'); const acct = (await c.get('/api/me')).json.user.account_id;
  out.hub_started_rss_mb = Math.round(process.memoryUsage().rss / 1048576);
  let t = Date.now(); for (let i = 0; i < POSTS; i++) { if (i % 100 === 0) await new Promise((res) => setImmediate(res)); hub.ledger.publish(acct, 'post.create', { kind: 'post', content: `solohost probe post ${i} cộng đồng Việt Nam community tokyo ${i % 97}` }); } out.ledger_publish_ms = Date.now() - t;
  const index = new DistributedIndex({ db: hub.db, localPeerId: () => 'PROBE' }); const idx = new PostIndexer({ db: hub.db, index, selfId: 'PROBE', region: 'VN' });
  t = Date.now(); for (let g = 0; g < 100000; g++) { const r = idx.sync(); if (!r.more) break; await new Promise((res) => setTimeout(res, 5)); }   // exactly what PostIndexer.start() does: short slices, yielding in between
  out.index_ms = Date.now() - t; out.indexed_docs = index.stats().documents;
  const H = new HealingSupervisor({ db: hub.db, ledger: hub.ledger, peers: hub.peers, remote: hub.remote, indexer: idx, cfg: { cycleBudgetMs: 2000, auditBatch: 500 } }); const cyc = [];
  for (let i = 0; i < 4; i++) { t = Date.now(); await H.cycle(); cyc.push(Date.now() - t); } out.healing_cycle_ms = { max: Math.max(...cyc), p50: pct(cyc, 0.5) }; out.findings = hub.db.get('SELECT COUNT(*) c FROM integrity_findings').c;
  const lat = []; let errors = 0, total = 0; const t1 = Date.now();
  for (let r = 0; r < ROUNDS; r++) await Promise.all(Array.from({ length: CONC }, async (_, i) => { const a = Date.now(); try { const res = await c.get(i % 2 ? '/api/feed/public' : '/api/search?q=' + encodeURIComponent('community tokyo ' + (i % 9))); total++; if (res.status >= 400) { errors++; (out.http_error_statuses = out.http_error_statuses || []).push(res.status); } } catch (e) { errors++; total++; (out.http_error_statuses = out.http_error_statuses || []).push(String(e && e.message).slice(0, 40)); } lat.push(Date.now() - a); }));
  out.http = { requests: total, errors, rps: Math.round(total / ((Date.now() - t1) / 1000)), p50_ms: pct(lat, 0.5), p95_ms: pct(lat, 0.95), p99_ms: pct(lat, 0.99) };
  const sl = []; for (let i = 0; i < 200; i++) { const a = process.hrtime.bigint(); index.searchWeighted([{ t: 'community', w: 1 }, { t: 'tokyo', w: 1 }], { limit: 30 }); sl.push(Number(process.hrtime.bigint() - a) / 1e6); } out.index_query_ms = { p50: pct(sl, 0.5), p95: pct(sl, 0.95) };
  await hub.stop(); clearInterval(sampler); clearInterval(loop); out.peak_rss_mb = Math.round(peak / 1048576); out.event_loop_lag_ms = { p50: pct(lag, 0.5), p99: pct(lag, 0.99), max: Math.max(...lag) };
  console.log('PROBE ' + JSON.stringify(out)); process.exit(0);
})().catch((e) => { console.error('PROBE_FAIL', e && e.stack || e); process.exit(2); });
