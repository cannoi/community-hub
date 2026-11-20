'use strict';
// One Hub per OS process. Controlled by the parent over IPC.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { openDatabase } = require('../../src/db');
const { DistributedIndex } = require('../../src/net/p2p/distributed-index');
const { ShardCoordinator } = require('../../src/net/p2p/index-replication');
const { ResourceGovernor } = require('../../src/net/p2p/index-governor');
const C = require('../../src/net/p2p/index-crypto');
const { TcpIndexTransport } = require('./tcp-index-transport');
const trust = { stateOf: () => 'TRUSTED', allow: () => ({ ok: true }), observe() {} };
const sg = C.createEd25519Signer(); const directory = {};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-proc-'));
const db = openDatabase(path.join(dir, 'h.sqlite'));
const index = new DistributedIndex({ db, localPeerId: () => sg.peerId });
const transport = new TcpIndexTransport({ signer: sg, directory });
const governor = new ResourceGovernor({ index, probes: { load1: () => 0.1, cpus: () => 8, totalMemMb: () => 16000, rssMb: () => 100, freeDiskMb: () => 1e6 } });
const coord = new ShardCoordinator({ index, db, transport, signer: sg, trust, governor, config: { leaseMs: 1500, heartbeatMs: 300, requestTimeoutMs: 600, electionStepMs: 400 } });
process.on('message', async (m) => {
  const reply = (v) => process.send({ id: m.id, v });
  try {
    if (m.cmd === 'init') { await coord.start(); return reply({ id: sg.peerId, port: transport.port }); }
    if (m.cmd === 'dir') { Object.assign(directory, m.dir); return reply(true); }
    if (m.cmd === 'adopt') return reply(await coord.adoptPlan(m.plans));
    if (m.cmd === 'tick') return reply(await coord.tick());
    if (m.cmd === 'add') { const r = index.upsertDocument({ origin_peer: sg.peerId, content_id: m.cid, visibility: 'public', title: m.text, text: m.text, updated_at: m.ts || Date.now() }, { local: true }); await coord.idle(); return reply(r); }
    if (m.cmd === 'search') return reply(index.searchLocal(m.q, { limit: 50 }).items.length);
    if (m.cmd === 'cid') { const { shardFor } = require('../../src/net/p2p/distributed-index'); for (let i = 0; ; i++) { const c = 'p' + m.n + '-' + i; if (shardFor(sg.peerId + ':' + c) === m.shard) return reply(c); } }
    if (m.cmd === 'status') { const s = coord.status(); return reply({ shard: s.shards[0] || null, digest: index.shardDigests(m.shard).digest }); }
    if (m.cmd === 'disk') return reply(fs.statSync(path.join(dir, 'h.sqlite')).size);
  } catch (e) { reply({ error: String(e && e.message) }); }
});
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
