'use strict';
// Benchmark of Phase 7 (real Hubs, HTTP on loopback; measures bytes on the wire and CPU, not WAN latency).  node scripts/delta-sync-bench.js [events]
const { startHub, Client, waitFor } = require('../tests/helpers');
const { HealingSupervisor } = require('../src/net/p2p/self-healing');
const N = Number(process.argv[2] || 2000);
const RL = { general: 1e6, write: 1e6, login: 1e5, upload: 1e4, federation: 1e6, assistant: 50 };
const ms = (a) => +(Number(process.hrtime.bigint() - a) / 1e6).toFixed(1);
(async () => {
  const base = { allowRegistration: true, contentSync: 'trusted', rateLimit: RL, syncIntervalMs: 3600000, antiEntropyMs: 3600000000, healing: { intervalMs: 0, cycleBudgetMs: 5000 } };
  const S = await startHub(base); const R = await startHub(base); const a = new Client(S.base); await a.setup('alice', 'correct-horse-9'); const c = new Client(R.base); await c.setup('carol', 'correct-horse-9');
  const acct = (await a.get('/api/me')).json.user.account_id;
  for (let i = 0; i < N; i++) S.ledger.publish(acct, 'post.create', { kind: 'post', content: 'benchmark post number ' + i + ' lorem ipsum dolor sit amet' });
  const p = R.peers.add(S.base, { state: 'trusted' }); R.peers.setPeerSync(p.id, true); const back = S.peers.add(R.peers.self().account + '@' + R.base, { state: 'trusted' }); S.peers.setPeerSync(back.id, true); S.peers.poke = () => {};
  R.peers.antiEntropy = null; await waitFor(() => !R.peers.inflight.has(p.id), 8000, 20);
  let bytes = 0; const real = R.peers.call.bind(R.peers); R.peers.call = async (...x) => { const r = await real(...x); bytes += JSON.stringify(r).length; return r; };
  const out = { events: N };
  let t = process.hrtime.bigint(); let r = await R.peers.syncPeer(R.peers.get(p.id)); out.first_sync = { ms: ms(t), accepted: r.accepted, kb: Math.round(bytes / 1024) };
  bytes = 0; t = process.hrtime.bigint(); r = await R.peers.syncPeer(R.peers.get(p.id)); out.second_sync_nothing_changed = { ms: ms(t), accepted: r.accepted, duplicate: r.duplicate, bytes };
  S.ledger.publish(acct, 'post.create', { kind: 'post', content: 'one more' }); bytes = 0; t = process.hrtime.bigint(); r = await R.peers.syncPeer(R.peers.get(p.id)); out.one_new_event = { ms: ms(t), accepted: r.accepted, bytes };
  bytes = 0; t = process.hrtime.bigint(); await R.remote.open(acct, { force: true }); const full = bytes; bytes = 0; await R.remote.open(acct, { force: true }); out.profile_snapshot = { first_full_kb: +(full / 1024).toFixed(1), unchanged_bytes: bytes };
  const H = new HealingSupervisor({ db: R.db, ledger: R.ledger, peers: R.peers, remote: R.remote, cfg: { auditBatch: 200, cycleBudgetMs: 5000 } });
  const cyc = []; for (let i = 0; i < 12; i++) { t = process.hrtime.bigint(); await H.cycle(); cyc.push(ms(t)); }
  out.healing_cycle_ms = { first: cyc[0], p50: cyc.slice().sort((x, y) => x - y)[6], max: Math.max(...cyc), audit_batch: 200, events_audited_per_sec: Math.round(200 / (cyc[0] / 1000)) };
  const { AntiEntropy } = require('../src/federation/delta'); const ae = new AntiEntropy({ peers: R.peers, ledger: R.ledger, db: R.db }); bytes = 0; t = process.hrtime.bigint(); const o = await ae.maybeRun(R.peers.get(p.id), { force: true }); out.anti_entropy = { ms: ms(t), actors_checked: o.checked, bytes };
  out.findings_after_clean_run = R.db.get('SELECT COUNT(*) c FROM integrity_findings').c; out.rss_mb = Math.round(process.memoryUsage().rss / 1048576);
  console.log(JSON.stringify(out, null, 1)); await S.stop(); await R.stop();
})().catch((e) => { console.error(e); process.exit(1); });
