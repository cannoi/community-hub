'use strict';
// Benchmark (in-process loopback; measures CPU/disk cost of replication, NOT network latency).
const fs = require('fs'), os = require('os'), path = require('path');
const { openDatabase } = require('../src/db');
const { DistributedIndex, shardFor } = require('../src/net/p2p/distributed-index');
const { ShardCoordinator } = require('../src/net/p2p/index-replication');
const { ResourceGovernor, LoopbackNetwork } = require('../src/net/p2p/index-governor');
const C = require('../src/net/p2p/index-crypto');
const N = Number(process.argv[2] || 3000), SHARD = 5;
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-bench-')); const net = new LoopbackNetwork(); const nodes = [];
  const trust = { stateOf: () => 'TRUSTED', allow: () => ({ ok: true }), observe() {} };
  for (let i = 0; i < 3; i++) { const sg = C.createEd25519Signer(); const db = openDatabase(path.join(dir, i + '.sqlite')); const index = new DistributedIndex({ db, localPeerId: () => sg.peerId, maxDocuments: 1e6, maxBytes: 1e9 });
    const gov = new ResourceGovernor({ index, probes: { load1: () => 0.1, cpus: () => 8, totalMemMb: () => 16000, rssMb: () => 100, freeDiskMb: () => 1e6 } });
    nodes.push({ sg, db, index, file: path.join(dir, i + '.sqlite'), coord: new ShardCoordinator({ index, db, transport: net.attach(sg.peerId), signer: sg, trust, governor: gov, config: { requestTimeoutMs: 5000 } }) }); }
  for (const n of nodes) await n.coord.start();
  const ids = nodes.map((n) => n.sg.peerId); const plan = [{ shard_id: SHARD, primary: { peer_id: ids[0] }, replicas: ids.slice(1).map((p) => ({ peer_id: p })) }];
  await nodes[1].coord.adoptPlan(plan); await nodes[2].coord.adoptPlan(plan); await nodes[0].coord.adoptPlan(plan);
  const text = 'Cộng đồng Pi Network toàn cầu chia sẻ kiến thức. '.repeat(20).slice(0, 1000);
  let made = 0, t0 = process.hrtime.bigint();
  for (let i = 0; made < N; i++) { const id = 'p' + i; if (shardFor(ids[0] + ':' + id) !== SHARD) continue; nodes[0].index.upsertDocument({ origin_peer: ids[0], content_id: id, visibility: 'public', title: 'Post ' + i, text: text + i, language: 'vi', region: 'VN' }, { local: true }); made++; }
  await nodes[0].coord.idle(); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let ticks = 0; t0 = process.hrtime.bigint();
  while (ticks < 200 && !nodes.every((n) => n.index.shardDigests(SHARD).digest === nodes[0].index.shardDigests(SHARD).digest)) { ticks++; await new Promise((r) => setTimeout(r, 50)); for (const n of nodes) await n.coord.tick(); }
  const catchup_ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const sz = (n) => fs.statSync(n.file).size + (fs.existsSync(n.file + '-wal') ? fs.statSync(n.file + '-wal').size : 0);
  const same = () => nodes.every((n) => n.index.shardDigests(SHARD).digest === nodes[0].index.shardDigests(SHARD).digest);
  console.log(JSON.stringify({ docs: N, replicated_ms: Math.round(ms), docs_per_sec: Math.round(N / (ms / 1000)), replicas_identical: same(), catchup_rounds: ticks, catchup_ms: Math.round(catchup_ms), rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    disk_mb_primary: +(sz(nodes[0]) / 1048576).toFixed(1), disk_mb_replica: +(sz(nodes[2]) / 1048576).toFixed(1), bytes_per_doc_replica: Math.round(sz(nodes[2]) / N), oplog_rows: nodes[2].db.get('SELECT COUNT(*) c FROM p2p_index_oplog').c }));
  // snapshot cost: brand-new replica
  const fresh = (() => { const sg = C.createEd25519Signer(); const db = openDatabase(path.join(dir, 'f.sqlite')); const index = new DistributedIndex({ db, localPeerId: () => sg.peerId, maxDocuments: 1e6, maxBytes: 1e9 }); return { sg, db, index }; })();
  const st = nodes[2].coord._states.get(SHARD); st.learners = [fresh.sg.peerId];
  const fc = new ShardCoordinator({ index: fresh.index, db: fresh.db, transport: net.attach(fresh.sg.peerId), signer: fresh.sg, trust, governor: nodes[0].coord.governor, config: { requestTimeoutMs: 20000 } });
  await fc.start(); const fs0 = fc._st(SHARD, true); fs0.role = 'LEARNER'; fs0.primary = ids[2]; fs0.epoch = st.epoch;
  t0 = process.hrtime.bigint(); const r = await fc._snapshotSync(fs0, fc._rt.get(SHARD), ids[2]); const sms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(JSON.stringify({ snapshot_join_ms: Math.round(sms), merged: r.merged, identical: fresh.index.shardDigests(SHARD).digest === nodes[0].index.shardDigests(SHARD).digest }));
  for (const n of nodes) n.db.close(); fresh.db.close(); fs.rmSync(dir, { recursive: true, force: true });
})();
