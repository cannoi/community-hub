'use strict';
// Coarse performance / scalability guards (generous bounds so they are stable on a Raspberry-Pi-class machine too).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startHub, Client } = require('./helpers');
const { Keystore } = require('../src/keystore');
const { Ledger } = require('../src/ledger');
const { Materializer } = require('../src/materializer');
const { openDatabase } = require('../src/db');
const { EventEmitter } = require('events');
const { tmp } = require('./helpers');
const path = require('path');

test('ingest 3000 signed events from 30 actors, rebuild views, and serve feed pages quickly', async () => {
  const mk = (n) => { const d = tmp(n); const db = openDatabase(path.join(d, 'c.db')); const ks = new Keystore(path.join(d, 'keys')); return { db, ks, ledger: new Ledger(db, ks, new Materializer(db, new EventEmitter())) }; };
  const src = mk('src'); const actors = Array.from({ length: 30 }, () => src.ks.generate().accountId);
  let t0 = Date.now();
  for (let i = 0; i < 3000; i++) src.ledger.publish(actors[i % 30], 'post.create', { kind: 'post', content: `perf post ${i} #tag${i % 7}` });
  const signMs = Date.now() - t0;
  const dst = mk('dst'); const evs = src.ledger.eventsAfter(0, 5000).map((e) => e.event);
  t0 = Date.now(); let accepted = 0;
  for (let i = 0; i < evs.length; i += 200) accepted += dst.ledger.ingestBatch(evs.slice(i, i + 200), { source: 'perf' }).summary.accepted || 0;
  const ingestMs = Date.now() - t0;
  assert.equal(accepted, 3000);
  t0 = Date.now(); dst.ledger.reindex(); const reindexMs = Date.now() - t0;
  assert.equal(dst.db.get('SELECT COUNT(*) c FROM posts').c, 3000);
  assert.ok(ingestMs < 60000 && reindexMs < 30000, `ingest ${ingestMs}ms reindex ${reindexMs}ms`);
  console.log(`# perf: sign+publish 3000 = ${signMs}ms, verify+ingest 3000 = ${ingestMs}ms, reindex = ${reindexMs}ms`);
});

test('feed and search stay fast with thousands of posts; pagination cost is flat', async () => {
  const hub = await startHub({ rateLimit: { general: 1e6, write: 1e6, login: 1e6, upload: 1e6, federation: 1e6, assistant: 100 } });
  const c = new Client(hub.base); await c.setup('owner');
  const acct = (await c.get('/api/identity')).json.account_id;
  const t0 = Date.now(); for (let i = 0; i < 1500; i++) hub.ledger.publish(acct, 'post.create', { kind: 'post', content: `bulk ${i} #bulk` });
  console.log(`# perf: published 1500 via ledger in ${Date.now() - t0}ms`);
  const timeIt = async (p) => { const s = process.hrtime.bigint(); const r = await c.get(p); assert.equal(r.status, 200); return Number(process.hrtime.bigint() - s) / 1e6; };
  const first = await timeIt('/api/feed/home?limit=50');
  let cursor = (await c.get('/api/feed/home?limit=50')).json.next_cursor; let deep = 0;
  for (let i = 0; i < 20 && cursor; i++) { const r = (await c.get('/api/feed/home?limit=50&cursor=' + cursor)).json; cursor = r.next_cursor; }
  deep = await timeIt('/api/feed/home?limit=50&cursor=' + cursor);
  const search = await timeIt('/api/search?q=bulk');
  const tag = await timeIt('/api/search?q=%23bulk');
  console.log(`# perf: first page ${first.toFixed(1)}ms, deep page ${deep.toFixed(1)}ms, search ${search.toFixed(1)}ms, tag ${tag.toFixed(1)}ms`);
  assert.ok(first < 500 && deep < 500 && search < 1000 && tag < 1000);
  // concurrent readers
  const t1 = Date.now(); await Promise.all(Array.from({ length: 50 }, () => c.get('/api/feed/public?limit=20'))); assert.ok(Date.now() - t1 < 5000);
  await hub.stop();
});
