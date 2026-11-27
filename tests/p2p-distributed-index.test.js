'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { DistributedIndex, shardFor, tokenize } = require('../src/net/p2p/distributed-index');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-index-'));
  const db = openDatabase(path.join(dir, 'hub.sqlite'));
  t.after(() => { try { db.close(); } catch {} fs.rmSync(dir, { recursive:true, force:true }); });
  return db;
}

test('Phase 5: migration 10 is additive and creates bounded index tables', (t) => {
  const db = fixture(t);
  assert.equal(db.get('SELECT COUNT(*) c FROM schema_migrations WHERE id=10').c, 1);
  for (const table of ['p2p_index_documents','p2p_index_terms','p2p_index_shards','p2p_index_assignments']) assert.equal(db.hasTable(table), true);
  assert.equal(db.hasTable('posts'), true);
});

test('Phase 5: only public verified content enters index; local content may be indexed', (t) => {
  const index = new DistributedIndex({ db:fixture(t), localPeerId:()=> 'local-peer' });
  assert.equal(index.upsertDocument({ origin_peer:'remote', content_id:'x', visibility:'private', title:'secret' },{ verified:true }).reason, 'not_public');
  assert.equal(index.upsertDocument({ origin_peer:'remote', content_id:'x', visibility:'public', title:'hello' }).reason, 'unverified_source');
  const r = index.upsertDocument({ origin_peer:'local-peer', content_id:'p1', visibility:'public', title:'Cộng đồng Pi Network', text:'Xin chào cộng đồng toàn cầu', language:'vi', region:'VN' },{ local:true });
  assert.equal(r.ok, true);
  assert.equal(index.searchLocal('cong dong',{}).items.length, 1);
});

test('Phase 5: unchanged hash is not re-indexed and updates replace terms atomically', (t) => {
  const index = new DistributedIndex({ db:fixture(t) });
  const doc = { origin_peer:'peerA', content_id:'p2', visibility:'public', title:'Pi Network', text:'Community hub', updated_at:100 };
  const a = index.upsertDocument(doc,{ verified:true });
  assert.equal(a.ok,true);
  assert.equal(index.upsertDocument(doc,{ verified:true }).unchanged,true);
  index.upsertDocument({...doc,title:'Solar system',text:'Astronomy discovery',updated_at:200},{verified:true});
  assert.equal(index.searchLocal('astronomy').items.length,1);
  assert.equal(index.searchLocal('community').items.length,0);
});

test('Phase 5: shard assignment is deterministic and excludes untrusted or unverified peers', (t) => {
  const index = new DistributedIndex({ db:fixture(t) });
  const candidates = [
    {peer_id:'peer-a',verified:true,trust_state:'TRUSTED',capacity:1},
    {peer_id:'peer-b',verified:true,trust_state:'TRUSTED',capacity:.8},
    {peer_id:'peer-c',verified:false,trust_state:'TRUSTED',capacity:1},
    {peer_id:'peer-d',verified:true,trust_state:'NEW',capacity:1},
  ];
  const p1 = index.planAssignments([0,1],candidates,{replicas:2});
  const p2 = index.planAssignments([0,1],candidates,{replicas:2});
  const strip = (plans) => plans.map(({ expires_at, ...rest }) => rest);   // expires_at = Date.now()+ttl differs across calls
  assert.deepEqual(strip(p1),strip(p2));
  assert.ok(p1.every(p=>p.primary && p.replicas.length===1 && !['peer-c','peer-d'].includes(p.primary.peer_id)));
  assert.equal(shardFor('same'),shardFor('same'));
});

test('Phase 5: remote shard manifests require a verifier and bounded expiry', (t) => {
  const index = new DistributedIndex({ db:fixture(t), verifyManifest:(m,peer)=>peer==='seed-peer' && m.signature==='valid' });
  const manifest={expires_at:Date.now()+60000,signature:'valid',shards:[{shard_id:1,digest:'a'.repeat(64),primary_peer:'peer-x',replicas:['peer-y']}]};
  assert.equal(index.applyShardManifest(manifest,{sourcePeer:'seed-peer',verified:true}).ok,true);
  assert.equal(index.applyShardManifest(manifest,{sourcePeer:'attacker',verified:true}).reason,'unverified_manifest');
  assert.equal(index.stats().assignments,2);
});

test('Phase 5: tokenization normalizes Vietnamese diacritics', () => {
  assert.deepEqual(tokenize('Cộng đồng Pi Network'),tokenize('cong dong pi network'));
});


test('Phase 5: verified shard snapshot can restore public index and rejects tampering', (t) => {
  const sourceDb = fixture(t);
  const source = new DistributedIndex({ db:sourceDb });
  source.upsertDocument({ origin_peer:'peerA', content_id:'post-1', visibility:'public', title:'Pi community', text:'Global network search', updated_at:123 },{verified:true});
  const shard = shardFor('peerA:post-1');
  const snapshot = source.exportShard(shard);
  assert.equal(snapshot.ok,true);
  const target = new DistributedIndex({ db:fixture(t), verifyManifest:(m,peer)=>peer==='trusted-peer' });
  assert.equal(target.importShardSnapshot(snapshot,{sourcePeer:'trusted-peer',verified:true}).imported,1);
  assert.equal(target.searchLocal('global network').items.length,1);
  const altered = {...snapshot, documents:snapshot.documents.map(d=>({...d,title:'tampered'}))};
  assert.equal(target.importShardSnapshot(altered,{sourcePeer:'trusted-peer',verified:true}).reason,'snapshot_integrity_mismatch');
});
