'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { EventEmitter } = require('events');
const { openDatabase } = require('../src/db');
const { Keystore } = require('../src/keystore');
const { Ledger } = require('../src/ledger');
const { Materializer } = require('../src/materializer');

function mk(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-led-' + name + '-'));
  const db = openDatabase(path.join(dir, 'c.db'));
  const ks = new Keystore(path.join(dir, 'keys'));
  const mat = new Materializer(db, new EventEmitter());
  const ledger = new Ledger(db, ks, mat);
  return { dir, db, ks, ledger, mat };
}
const clone = (o) => JSON.parse(JSON.stringify(o));

test('B6 accepts a valid signed event; B7 rejects tampered payload', () => {
  const A = mk('a'); const { accountId } = A.ks.generate();
  const ev = A.ledger.publish(accountId, 'post.create', { kind: 'post', content: 'hello #World' });
  const B = mk('b');
  assert.equal(B.ledger.ingest(ev, { source: 'p' }).status, 'accepted');
  const t = clone(ev); t.payload.content = 'tampered';
  const C = mk('c');
  const r = C.ledger.ingest(t, { source: 'p' });
  assert.equal(r.status, 'rejected'); assert.equal(r.reason, 'bad_event_id');
  assert.equal(C.db.get('SELECT COUNT(*) c FROM events').c, 0);
  // forged actor: swap actor id to someone else's while keeping signature
  const other = A.ks.generate();
  const f = clone(ev); f.actor_id = other.accountId;
  assert.equal(C.ledger.ingest(f).status, 'rejected');
  // valid id but invalid signature
  const s = clone(ev); s.signature = ev.signature.slice(0, 80) + 'AAAAAA';
  assert.equal(C.ledger.ingest(s).reason, 'bad_signature');
});

test('B8 duplicate delivery is idempotent', () => {
  const A = mk('a'); const { accountId } = A.ks.generate();
  const ev = A.ledger.publish(accountId, 'post.create', { kind: 'post', content: 'once' });
  const B = mk('b');
  assert.equal(B.ledger.ingest(ev).status, 'accepted');
  assert.equal(B.ledger.ingest(ev).status, 'duplicate');
  assert.equal(B.db.get('SELECT COUNT(*) c FROM posts').c, 1);
  assert.equal(B.db.get('SELECT COUNT(*) c FROM events').c, 1);
});

test('B9 detects missing sequence and fills it from the actor range', () => {
  const A = mk('a'); const { accountId } = A.ks.generate();
  const e1 = A.ledger.publish(accountId, 'post.create', { kind: 'post', content: 'one' });
  const e2 = A.ledger.publish(accountId, 'post.create', { kind: 'post', content: 'two' });
  const e3 = A.ledger.publish(accountId, 'post.create', { kind: 'post', content: 'three' });
  const B = mk('b');
  assert.equal(B.ledger.ingest(e1).status, 'accepted');
  const r = B.ledger.ingest(e3);
  assert.equal(r.status, 'gap'); assert.equal(r.expected, 2);
  assert.equal(B.ledger.openGaps().length, 1);
  for (const ev of A.ledger.eventsForActor(accountId, r.expected, 10)) B.ledger.ingest(ev);
  assert.equal(B.db.get('SELECT COUNT(*) c FROM posts').c, 3);
  assert.equal(B.ledger.openGaps().length, 0);
});

test('fork (same sequence, different content) is reported, first history kept', () => {
  const A = mk('a'); const { accountId } = A.ks.generate();
  const e1 = A.ledger.publish(accountId, 'post.create', { kind: 'post', content: 'one' });
  // second hub signs a different event 1 with the same key (simulated equivocation)
  const A2 = mk('a2'); A2.ks.importKey(A.ks.exportKey(accountId, 'longpassphrase1'), 'longpassphrase1');
  const e1b = A2.ledger.publish(accountId, 'post.create', { kind: 'post', content: 'different' });
  const B = mk('b');
  assert.equal(B.ledger.ingest(e1).status, 'accepted');
  assert.equal(B.ledger.ingest(e1b).status, 'conflict');
  assert.equal(B.ledger.conflicts().length, 1);
  assert.equal(B.db.get("SELECT content FROM posts").content, 'one');
});

test('B10 reindex rebuilds views from persisted events (edit, delete, react, follow)', () => {
  const A = mk('a'); const me = A.ks.generate(); const you = A.ks.generate();
  const p = A.ledger.publish(me.accountId, 'post.create', { kind: 'post', content: 'first #tag' });
  A.ledger.publish(me.accountId, 'post.edit', { content: 'edited #tag2' }, { target: p.event_id });
  const q = A.ledger.publish(me.accountId, 'post.create', { kind: 'post', content: 'to delete' });
  A.ledger.publish(me.accountId, 'post.delete', {}, { target: q.event_id });
  A.ledger.publish(you.accountId, 'react.add', { kind: 'like' }, { target: p.event_id });
  A.ledger.publish(you.accountId, 'post.edit', { content: 'hijack' }, { target: p.event_id }); // not author: no effect
  A.ledger.publish(you.accountId, 'follow.add', { account: me.accountId });
  const snap = () => ({
    posts: A.db.all('SELECT event_id,content,deleted_at,edited_at FROM posts ORDER BY event_id'),
    reacts: A.db.all('SELECT target_event,user_id,type FROM reactions').length,
    follows: A.db.all('SELECT * FROM follows').length,
    tags: A.db.all('SELECT tag FROM post_tags ORDER BY tag').map((r) => r.tag),
  });
  const before = snap();
  assert.equal(before.posts.find((x) => x.event_id === p.event_id).content, 'edited #tag2');
  assert.ok(before.posts.find((x) => x.event_id === q.event_id).deleted_at > 0);
  assert.deepEqual(before.tags, ['tag2']);
  A.db.run('DELETE FROM follows'); A.db.run('DELETE FROM reactions'); // corrupt the views
  const d = A.ledger.reindex();
  assert.equal(d.event_count, 7);
  assert.deepEqual(snap(), before);
  assert.deepEqual(A.ledger.verifyAll().problems, []);
});

test('B11 incompatible schema / unknown type fails safely and stores nothing', () => {
  const A = mk('a'); const { accountId } = A.ks.generate();
  const ev = A.ledger.publish(accountId, 'post.create', { kind: 'post', content: 'x' });
  const B = mk('b');
  const v2 = clone(ev); v2.schema_version = 2;
  assert.equal(B.ledger.ingest(v2).reason, 'unsupported_schema');
  const unk = clone(ev); unk.event_type = 'nuke.everything';
  assert.equal(B.ledger.ingest(unk).reason, 'unsupported_type');
  const extra = clone(ev); extra.evil = 1;
  assert.equal(B.ledger.ingest(extra).reason, 'malformed');
  assert.equal(B.ledger.ingest('garbage').status, 'rejected');
  assert.equal(B.db.get('SELECT COUNT(*) c FROM events').c, 0);
  const huge = clone(ev); huge.payload.content = 'x'.repeat(5000);
  assert.equal(B.ledger.ingest(huge).status, 'rejected');
});

test('failed materialization rolls back the whole ingestion', () => {
  const A = mk('a'); const { accountId } = A.ks.generate();
  const ev = A.ledger.publish(accountId, 'post.create', { kind: 'post', content: 'x' });
  const B = mk('b');
  B.mat.apply = () => { throw new Error('boom'); };
  assert.equal(B.ledger.ingest(ev).reason, 'internal_error');
  assert.equal(B.db.get('SELECT COUNT(*) c FROM events').c, 0);
  assert.equal(B.db.get('SELECT COUNT(*) c FROM actor_state').c, 0);
});

test('canonical serialization is deterministic and rejects floats', () => {
  const { canonicalize } = require('../src/util');
  assert.equal(canonicalize({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
  assert.throws(() => canonicalize({ a: 1.5 }));
  assert.throws(() => canonicalize({ a: undefined }));
});
