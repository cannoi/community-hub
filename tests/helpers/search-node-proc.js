'use strict';
// One Hub per OS process for the federated-search simulation (real TCP, authenticated envelope, see tcp-index-transport.js).
const fs = require('fs'); const os = require('os'); const path = require('path');
const { openDatabase } = require('../../src/db');
const { DistributedIndex } = require('../../src/net/p2p/distributed-index');
const { SearchService, FederatedSearch } = require('../../src/net/p2p/federated-search');
const { ResourceGovernor } = require('../../src/net/p2p/index-governor');
const ST = require('../../src/net/p2p/search-text');
const C = require('../../src/net/p2p/index-crypto');
const { TcpIndexTransport } = require('./tcp-index-transport');
const trust = { stateOf: () => 'TRUSTED', allow: () => ({ ok: true }), observe() {} };
const sg = C.createEd25519Signer(); const directory = {}; let hints = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srch-proc-'));
const db = openDatabase(path.join(dir, 'h.sqlite'));
const index = new DistributedIndex({ db, localPeerId: () => sg.peerId });
const governor = new ResourceGovernor({ index, probes: { load1: () => 0.1, cpus: () => 8, totalMemMb: () => 16000, rssMb: () => 100, freeDiskMb: () => 1e6 } });
const transport = new TcpIndexTransport({ signer: sg, directory });
const service = new SearchService({ index, signer: sg, selfId: sg.peerId, trust, governor });
let fed = null;
process.on('message', async (m) => {
  const reply = (v) => process.send({ id: m.id, v });
  try {
    if (m.cmd === 'init') { await transport.start((from, msg) => service.handle(from, msg)); fed = new FederatedSearch({ index, transport, signer: sg, selfId: sg.peerId, trust, governor, profile: { region: m.region, languages: m.languages }, peers: () => hints, config: { stageTimeoutMs: 1200, totalTimeoutMs: 6000 } }); return reply({ id: sg.peerId, port: transport.port }); }
    if (m.cmd === 'dir') { Object.assign(directory, m.dir); hints = m.hints.filter((h) => h.peer_id !== sg.peerId); return reply(true); }
    if (m.cmd === 'add') { const r = index.upsertDocument({ origin_peer: sg.peerId, content_id: m.cid, visibility: 'public', title: '', text: m.text, language: ST.detectLanguage(m.text).lang, region: m.region, topics: ST.mapTopics(m.text), updated_at: Date.now() - (m.ageDays || 1) * 86400000 }, { local: true }); return reply(r.ok); }
    if (m.cmd === 'search') { const s = await fed.search({ q: m.q, scope: m.scope || 'global', limit: 30 }); return reply({ state: s.state, ids: s.items.map((i) => i.content_id), labels: s.items.map((i) => i.hub.label), sources: s.sources, regions: [...new Set(s.items.map((i) => i.region))] }); }
  } catch (e) { reply({ error: String(e && e.message) }); }
});
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
