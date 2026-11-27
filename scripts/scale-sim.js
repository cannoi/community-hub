'use strict';
/**
 * Phase 8 — SCALE SIMULATION (acceptance G).  node scripts/scale-sim.js [--write] [--quick]
 *
 * TEST CLASS: algorithmic simulation on ONE machine. It runs the REAL rendezvous/Directory code over synthetic populations
 * (100 … 1,000,000 Hubs) and a Monte-Carlo model for search latency. It is NOT a network test: no sockets, no NAT, no real
 * latency, no real adversary. Where a size is too large to run exactly it is EXTRAPOLATED and marked as such.
 *
 * Population model (matches ResourceGovernor tiers): 60% weak (host nothing), 30% medium (8 shards), 10% strong (32 shards);
 * 70% of Hubs have earned TRUSTED; only TRUSTED non-weak Hubs are shard-host candidates. 64 shards, replication 3.
 */
const fs = require('fs'), path = require('path');
const crypto = require('crypto');
const { rendezvousScore } = require('../src/net/p2p/distributed-index');
const { RegionalDirectory } = require('../src/net/p2p/bootstrap/directory');

const QUICK = process.argv.includes('--quick');
const SIZES = QUICK ? [100, 1000, 10000] : [100, 1000, 10000, 100000, 1000000];
const SHARDS = 64, R = 3;
let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const REGIONS = ['VN', 'JP', 'US', 'DE', 'FR', 'GB', 'KR', 'SG'];
const pid = (i) => '12D3KooW' + crypto.createHash('sha256').update('hub' + i).digest('base64url').slice(0, 44);
const ms = (t) => +(Number(process.hrtime.bigint() - t) / 1e6).toFixed(1);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); };

function population(n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) { const r = rnd(); const tier = r < 0.6 ? 'weak' : r < 0.9 ? 'medium' : 'strong'; out[i] = { id: pid(i), tier, cap: tier === 'weak' ? 0 : tier === 'medium' ? 8 : 32, w: tier === 'medium' ? 0.5 : 1, trusted: rnd() < 0.7, region: REGIONS[Math.floor(rnd() * REGIONS.length)] }; }
  return out;
}
const eligible = (pop) => pop.filter((h) => h.trusted && h.cap > 0);

/** Exact streaming top-K per shard (same scoring as DistributedIndex.planAssignments). */
function rank(elig, shard, k) {
  const top = [];
  for (const h of elig) {
    const s = rendezvousScore(shard, h.id) * h.w;
    if (top.length < k || s > top[top.length - 1].s) { top.push({ h, s }); top.sort((a, b) => b.s - a.s); if (top.length > k) top.pop(); }
  }
  return top.map((x) => x.h);
}
/** Greedy cover: fewest peers that together host every shard (what a full-coverage query must contact). */
function coverSize(elig, power) {
  const w = (h) => Math.pow(h.w, power); const hostsOf = [];
  for (let s = 0; s < SHARDS; s++) { const top = []; for (const h of elig) { const sc = rendezvousScore(s, h.id) * w(h); if (top.length < R || sc > top[top.length - 1].sc) { top.push({ id: h.id, sc }); top.sort((a, b) => b.sc - a.sc); if (top.length > R) top.pop(); } } hostsOf.push(new Set(top.map((x) => x.id))); }
  const uncovered = new Set([...Array(SHARDS).keys()]); const count = new Map(); for (const hs of hostsOf) for (const h of hs) count.set(h, (count.get(h) || 0) + 1); let n = 0;
  while (uncovered.size) { let best = null, bc = -1; for (const [h] of count) { let c = 0; for (const s of uncovered) if (hostsOf[s].has(h)) c++; if (c > bc) { bc = c; best = h; } } if (bc <= 0) break; n++; for (const s of [...uncovered]) if (hostsOf[s].has(best)) uncovered.delete(s); }
  return n;
}
function plan(elig, shards, k = 10) { return shards.map((s) => rank(elig, s, k)); }

// ------------------------------------------------------------------ A. shard assignment: cost, balance, capacity, churn
function simAssignment(n) {
  const pop = population(n); const elig = eligible(pop); const out = { hubs: n, eligible_hosts: elig.length, method: 'exact' };
  let shardList = [...Array(SHARDS).keys()], factor = 1;
  if (n > 100000) { shardList = [0, 1, 2, 3, 4, 5, 6, 7]; factor = SHARDS / 8; out.method = 'EXTRAPOLATED (8 of 64 shards computed exactly, time x8)'; }
  const t = process.hrtime.bigint(); const ranked = plan(elig, shardList); out.plan_ms = +(ms(t) * factor).toFixed(0);
  if (factor === 1) {
    const load = new Map(); let under = 0; const members = [];
    for (let s = 0; s < SHARDS; s++) { const chosen = []; for (const h of ranked[s]) { if (chosen.length >= R) break; if ((load.get(h.id) || 0) < h.cap) { chosen.push(h); load.set(h.id, (load.get(h.id) || 0) + 1); } } if (chosen.length < R) under++; members.push(chosen.map((h) => h.id)); }
    const naive = new Map(); for (let s = 0; s < SHARDS; s++) for (const h of ranked[s].slice(0, R)) naive.set(h.id, (naive.get(h.id) || 0) + 1);
    out.max_shards_per_host_capacity_aware = Math.max(0, ...load.values()); out.hosts_used = load.size; out.shards_under_replicated_with_caps = under;
    out.naive_top3_max_load = Math.max(0, ...naive.values()); out.naive_hosts_over_cap = [...naive].filter(([id, c]) => c > (elig.find((h) => h.id === id) || { cap: 0 }).cap).length;
    // churn: remove x% of eligible hosts at random; fraction of (shard, member) slots that moved vs the ideal x%
    out.churn = {};
    for (const frac of [0.01, 0.05, 0.2]) {
      const gone = new Set(elig.filter(() => rnd() < frac).map((h) => h.id)); const remain = elig.filter((h) => !gone.has(h.id)); const r2 = plan(remain, [...Array(SHARDS).keys()], R);
      let moved = 0, total = 0; for (let s = 0; s < SHARDS; s++) { const before = new Set(ranked[s].slice(0, R).map((h) => h.id)); for (const h of r2[s]) { total++; if (!before.has(h.id)) moved++; } }
      out.churn[(frac * 100) + '%'] = { slots_moved_pct: +(100 * moved / total).toFixed(1), ideal_pct: frac * 100 };
    }
  }
  return out;
}

// ------------------------------------------------------------------ A2. plan agreement when every Hub only knows a partial candidate view
function simAgreement() {
  const pop = population(20000); const elig = eligible(pop); const views = {}; const out = {};
  for (const p of [1, 0.5, 0.1, 0.01]) {
    const hubs = 60; let samePrimary = 0, sameTop3 = 0, pairs = 0; const plans = [];
    for (let i = 0; i < hubs; i++) { const view = p === 1 ? elig : elig.filter(() => rnd() < p); plans.push(rank(view, 7, 3).map((h) => h.id)); }
    for (let i = 0; i < hubs; i++) for (let j = i + 1; j < hubs; j++) { pairs++; if (plans[i][0] === plans[j][0]) samePrimary++; if (plans[i].join() === plans[j].join()) sameTop3++; }
    out[(p * 100) + '% view'] = { same_primary_pct: +(100 * samePrimary / pairs).toFixed(1), same_top3_pct: +(100 * sameTop3 / pairs).toFixed(1) };
  }
  return out;
}

// ------------------------------------------------------------------ B. search: reachability + latency model
function simSearch(n) {
  const pop = population(n); const elig = eligible(pop); const out = { hubs: n };
  out.reach_without_replicas_pct = +(Math.min(100, 100 * 25 / n)).toFixed(2);                 // 24 peers + local, random peers
  if (n <= 100000) {
    const hostsOf = []; for (let s = 0; s < SHARDS; s++) hostsOf.push(new Set(rank(elig, s, R).map((h) => h.id)));
    const uncovered = new Set([...Array(SHARDS).keys()]); const chosen = []; const count = new Map();
    for (const hs of hostsOf) for (const h of hs) count.set(h, (count.get(h) || 0) + 1);
    while (uncovered.size && chosen.length < 64) { let best = null, bc = -1; for (const [h] of count) { const c = [...uncovered].filter((s) => hostsOf[s].has(h)).length; if (c > bc) { bc = c; best = h; } } if (bc <= 0) break; chosen.push(best); for (const s of [...uncovered]) if (hostsOf[s].has(best)) uncovered.delete(s); }
    out.peers_needed_to_cover_all_shards = chosen.length; out.cover_fits_in_24_peer_budget = chosen.length <= 24;
    out.peers_needed_with_capacity_power_3 = coverSize(elig, 3); out.peers_needed_with_capacity_power_6 = coverSize(elig, 6);
  } else out.peers_needed_to_cover_all_shards = 'not computed (>100k); bounded by 64 shards x R=3 hosts';
  // Monte-Carlo: time to first remote results / completion with stage fan-out 6, stage timeout 2500 ms, failure rate f
  const lat = (same) => Math.exp(Math.log(same ? 30 : 160) + 0.5 * (rnd() + rnd() + rnd() - 1.5) * 1.6);
  out.latency_model_ms = {};
  for (const f of [0.05, 0.3]) {
    const first = [], done = [], partial = [];
    for (let i = 0; i < 2000; i++) {
      let t = 0, firstAt = null, fails = 0;
      for (let stage = 0; stage < 4; stage++) { let worst = 0; for (let p = 0; p < 6; p++) { const fail = rnd() < f; const rtt = fail ? 2500 : lat(stage === 0); if (fail) fails++; else if (firstAt === null) firstAt = t + rtt; worst = Math.max(worst, rtt); } t += worst; }
      first.push(firstAt === null ? t : firstAt); done.push(t); partial.push(fails > 0 ? 1 : 0);
    }
    out.latency_model_ms[`fail_${f * 100}%`] = { first_remote_p50: pct(first, 0.5), first_remote_p95: pct(first, 0.95), complete_p50: pct(done, 0.5), complete_p95: pct(done, 0.95), sessions_partial_pct: +(100 * partial.reduce((a, b) => a + b, 0) / partial.length).toFixed(0), local_results_ms: '~0 (local stage is immediate)' };
  }
  return out;
}

// ------------------------------------------------------------------ C. directory: bounded memory + paged queries (REAL RegionalDirectory)
function simDirectory(n, maxEntries) {
  const dir = new RegionalDirectory({ maxEntries, ttlMs: 3600000 }); const m0 = process.memoryUsage().heapUsed; const t = process.hrtime.bigint(); let stored = 0;
  for (let i = 0; i < n; i++) { const r = dir.put({ peer_id: pid(i), multiaddrs: [`/ip4/8.8.${i % 250}.${i % 253}/tcp/8181/ws`], region: REGIONS[i % 8], languages: ['vi', 'en'], topics: ['tech'], verified: true }); if (r.ok) stored++; }
  const putMs = ms(t); const q = []; for (let i = 0; i < 20; i++) { const a = process.hrtime.bigint(); dir.query({ region: REGIONS[i % 8], language: 'vi', limit: 20 }); q.push(ms(a)); }
  const mem = (process.memoryUsage().heapUsed - m0) / 1048576;
  return { offered: n, cap: maxEntries, stored: dir.stats().entries ?? stored, put_ms_total: putMs, put_per_sec: Math.round(n / (putMs / 1000)), query_p50_ms: pct(q, 0.5), query_p95_ms: pct(q, 0.95), heap_mb: +mem.toFixed(1), page_size_max_returned: 20 };
}

(async () => {
  const res = { class: 'ALGORITHMIC SIMULATION (single machine) — not a network test', date: new Date().toISOString(), node: process.version, assignment: {}, search: {}, directory: [], plan_agreement_partial_views: null };
  for (const n of SIZES) { console.error('assignment', n); res.assignment[n] = simAssignment(n); }
  console.error('agreement'); res.plan_agreement_partial_views = simAgreement();
  for (const n of SIZES) { console.error('search', n); res.search[n] = simSearch(n); }
  for (const [n, cap] of [[5000, 5000], [50000, 50000], [100000, 100000]]) { if (QUICK && n > 5000) continue; console.error('directory', n); res.directory.push(simDirectory(n, cap)); }
  console.log(JSON.stringify(res, null, 1));
  if (process.argv.includes('--write')) fs.writeFileSync(path.join(__dirname, '..', 'docs', 'SCALE_SIMULATION_RESULTS.json'), JSON.stringify(res, null, 1));
})();
