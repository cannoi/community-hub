'use strict';
/**
 * Phase 8 — SoloHost compatibility + load. TEST CLASS: single-machine integration load (real Hub, real SQLite, real HTTP on loopback).
 * Thresholds are regression guards for a constrained process, NOT promises for Raspberry-Pi class hardware (not measured here).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..'); const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('SoloHost: deployment files are unprivileged — no privileged mode, no docker.sock, no host network, non-root user, health check, scripts disabled during install', () => {
  const compose = read('docker-compose.yml'); const docker = ['Dockerfile', 'Dockerfile.p2p', 'Dockerfile.seed'].map((f) => [f, read(f)]);
  assert.ok(!/privileged\s*:\s*true/i.test(compose), 'privileged'); assert.ok(!/docker\.sock/i.test(compose), 'docker.sock'); assert.ok(!/network_mode\s*:\s*["']?host/i.test(compose), 'host network'); assert.ok(!/cap_add/i.test(compose), 'cap_add'); assert.ok(!/pid\s*:\s*["']?host/i.test(compose));
  assert.match(compose, /healthcheck:/); assert.match(compose, /restart:\s*unless-stopped/); assert.match(compose, /hub-data:\/app\/data/, 'one data volume');
  for (const [f, s] of docker) { assert.match(s, /^USER node/m, f + ' runs as non-root'); assert.ok(!/docker\.sock/.test(s), f); assert.ok(!/curl[^\n]*\|\s*(ba)?sh/.test(s), f + ' no curl|sh'); if (/npm (install|ci)/.test(s)) assert.match(s, /--ignore-scripts/, f + ' install scripts disabled'); assert.match(s, /HEALTHCHECK/, f); }
  assert.match(compose, /HUB_ALLOW_REGISTRATION=false/, 'open registration is off by default in the shipped compose');
});
test('SoloHost: zero-config — the shipped compose needs no network, IP, peer or DNS input from the user', () => {
  const compose = read('docker-compose.yml'); const required = [...compose.matchAll(/\$\{([A-Z_]+)\}/g)].map((m) => m[1]);
  assert.deepEqual(required, [], 'every variable has a default; nothing is mandatory: ' + required.join());
  for (const k of ['P2P_FIXED_SEEDS', 'PRESENCE_SEEDS', 'P2P_PUBLIC_PORT', 'HUB_PUBLIC_URL']) assert.match(compose, new RegExp(k + '=\\$\\{' + k + ':-'), k + ' optional with default');
});
test('Release hygiene: no secrets, keys or tokens are shipped; version strings agree', () => {
  const bad = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.git', 'data'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|json|md|yml|yaml|sh|html|css|env)$/.test(e.name) || e.name === 'Dockerfile') { const s = fs.readFileSync(p, 'utf8'); if (/-----BEGIN (RSA |EC |OPENSSH |ED25519 )?PRIVATE KEY-----/.test(s) || /\bghp_[A-Za-z0-9]{30,}/.test(s) || /\bAKIA[0-9A-Z]{16}\b/.test(s) || /\bsk-[A-Za-z0-9]{32,}\b/.test(s) || /xox[baprs]-[A-Za-z0-9-]{20,}/.test(s)) bad.push(path.relative(ROOT, p)); } } };
  walk(ROOT); assert.deepEqual(bad, []);
  assert.ok(!fs.existsSync(path.join(ROOT, '.env')) && !fs.existsSync(path.join(ROOT, 'data')), 'no .env / data directory in the release tree');
  const v = JSON.parse(read('package.json')).version; assert.match(read('Dockerfile').split('\n')[0], new RegExp(v.replace(/\./g, '\\.')), 'Dockerfile header matches package version');
});

test('SoloHost runtime: a 192 MB heap-capped process runs a 3,000-post Hub with indexing, healing and 240 concurrent HTTP requests without OOM; event loop stays responsive', { timeout: 240000 }, () => {
  const r = spawnSync(process.execPath, ['--max-old-space-size=192', path.join(__dirname, 'helpers', 'solohost-probe.js')], { cwd: ROOT, encoding: 'utf8', timeout: 220000, env: { ...process.env, PROBE_POSTS: '3000', PROBE_CONC: '40', PROBE_ROUNDS: '6' } });
  assert.equal(r.status, 0, 'exit ' + r.status + ' ' + (r.stderr || '').slice(-400)); const line = r.stdout.split('\n').find((l) => l.startsWith('PROBE ')); assert.ok(line, 'probe output'); const o = JSON.parse(line.slice(6));
  console.log('# SOLOHOST_PROBE ' + JSON.stringify(o));
  assert.ok(o.heap_limit_mb <= 260, 'heap really capped: ' + o.heap_limit_mb); assert.equal(o.indexed_docs, 3000); assert.equal(o.http.errors, 0, 'no failed requests under load');
  assert.ok(o.peak_rss_mb < 420, 'peak RSS ' + o.peak_rss_mb + ' MB'); assert.ok(o.http.p95_ms < 3000, 'HTTP p95 ' + o.http.p95_ms); assert.ok(o.healing_cycle_ms.max < 2500, 'healing cycle ' + o.healing_cycle_ms.max + ' ms'); assert.ok(o.event_loop_lag_ms.p99 < 400, 'event-loop lag p99 ' + o.event_loop_lag_ms.p99 + ' ms'); assert.ok(o.event_loop_lag_ms.max < 3000, 'worst stall ' + o.event_loop_lag_ms.max + ' ms');
  assert.equal(o.findings, 0, 'a clean Hub produces no integrity findings (no false positives)');
});

// ---------------------------------------------------------------------------------------------------------------- search under load
const { DistributedIndex } = require('../src/net/p2p/distributed-index'); const { SearchService, FederatedSearch } = require('../src/net/p2p/federated-search');
const { ResourceGovernor, LoopbackNetwork } = require('../src/net/p2p/index-governor'); const C = require('../src/net/p2p/index-crypto'); const { openDatabase } = require('../src/db'); const os = require('os');
test('LOAD search: 5 Hubs x 4,000 documents, 150 concurrent federated sessions — no errors, bounded memory, honest backpressure instead of collapse', { timeout: 180000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-load-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const net = new LoopbackNetwork(); const trust = { stateOf: () => 'TRUSTED', allow: () => ({ ok: true }), observe() {} };
  const probes = { load1: () => 0.1, cpus: () => 8, totalMemMb: () => 16000, rssMb: () => 100, freeDiskMb: () => 1e6 };
  const hubs = Array.from({ length: 5 }, (_, i) => { const sg = C.createEd25519Signer(); const db = openDatabase(path.join(dir, i + '.sqlite')); const index = new DistributedIndex({ db, localPeerId: () => sg.peerId, maxDocuments: 1e6, maxBytes: 1e9 }); const gov = new ResourceGovernor({ index, probes });
    return { sg, db, index, gov, tr: net.attach(sg.peerId), region: ['VN', 'JP', 'DE', 'FR', 'US'][i], svc: new SearchService({ index, signer: sg, selfId: sg.peerId, trust, governor: gov, config: { rateBurst: 400, ratePerSec: 400 } }) }; });
  t.after(() => hubs.forEach((h) => h.db.close()));
  hubs.forEach((h, k) => { for (let i = 0; i < 4000; i++) h.index.upsertDocument({ origin_peer: h.sg.peerId, content_id: 'p' + i, visibility: 'public', title: '', text: `post ${i} about community ${['tokyo', 'berlin', 'hanoi', 'paris'][i % 4]} and travel ${i % 31}`, language: 'en', region: h.region, updated_at: Date.now() - (i % 60) * 86400000 }, { local: true }); });
  for (const h of hubs) await h.tr.start((f, m) => h.svc.handle(f, m));
  const peers = () => hubs.slice(1).map((h) => ({ peer_id: h.sg.peerId, region: h.region, languages: ['en'], topics: [] }));
  const fed = new FederatedSearch({ index: hubs[0].index, transport: hubs[0].tr, signer: hubs[0].sg, selfId: hubs[0].sg.peerId, trust, governor: hubs[0].gov, profile: { region: 'VN', languages: ['en'] }, peers, config: { maxPerUser: 1000, cacheTtlMs: 0, stageTimeoutMs: 4000, totalTimeoutMs: 15000 } });
  const rss0 = process.memoryUsage().rss; const lat = []; let bad = 0, partial = 0; const states = {};
  await Promise.all(Array.from({ length: 150 }, async (_, i) => { const a = Date.now(); try { const s = await fed.search({ q: ['community tokyo', 'travel 7', 'community paris travel', 'berlin'][i % 4] + ' ' + (i % 11), scope: 'global', user: 'u' + i, limit: 20 }); states[s.state] = (states[s.state] || 0) + 1; if (!s.items.length) bad++; if (s.state === 'partial') partial++; } catch { bad++; } lat.push(Date.now() - a); }));
  const p = (q) => [...lat].sort((x, y) => x - y)[Math.floor(q * lat.length)]; console.log('# LOAD_SEARCH ' + JSON.stringify({ sessions: 150, p50_ms: p(0.5), p95_ms: p(0.95), max_ms: Math.max(...lat), states, rss_growth_mb: Math.round((process.memoryUsage().rss - rss0) / 1048576) }));
  assert.equal(bad, 0, 'every session returned results without throwing'); assert.ok(p(0.95) < 12000, 'p95 ' + p(0.95)); assert.ok((process.memoryUsage().rss - rss0) / 1048576 < 250, 'memory growth bounded');
  assert.ok(fed._sessions.size <= fed.cfg.maxSessions, 'sessions bounded'); assert.ok(!states.degraded && !states.offline, 'self-throttling is reported as partial, never as a degraded network: ' + JSON.stringify(states)); assert.equal(fed.metrics.failures, 0, 'no healthy peer was counted as failed'); assert.ok([...fed._health.values()].every((h) => h.openUntil === 0), 'no circuit breaker tripped by our own load');
});
