'use strict';
/**
 * Phase 5 — Store-and-Forward persistent message delivery tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { openDatabase } = require('../src/db');
const { LocalMessaging, newMsgId } = require('../src/net/p2p/local-messaging');
const { tmp } = require('./helpers');

function openTmpDb() {
  const dir = tmp('sf');
  const file = path.join(dir, 't.db');
  const db = openDatabase(file, { info() {}, warn() {} });
  return { db, dir, file };
}

test('Phase 5: migration 7 creates p2p_outbox tables', () => {
  const { db } = openTmpDb();
  try {
    assert.ok(db.hasTable('p2p_outbox'));
    assert.ok(db.hasTable('p2p_inbox_seen'));
    assert.ok(db.hasColumn('p2p_outbox', 'state'));
    assert.ok(db.hasColumn('p2p_outbox', 'order_key'));
    assert.ok(db.hasColumn('p2p_outbox', 'expires_at'));
  } finally {
    db.close();
  }
});

test('Phase 5: send without node queues to DB with state=queued', async () => {
  const { db } = openTmpDb();
  try {
    const msg = new LocalMessaging({ getNode: () => null, db });
    await msg.start();
    const r = await msg.send('12D3KooWpeerA', 'chat', { text: 'hello' });
    assert.equal(r.status, 'queued');
    assert.ok(r.id);
    assert.equal(msg.pendingCount(), 1);
    const row = db.get('SELECT * FROM p2p_outbox WHERE id=?', r.id);
    assert.ok(row);
    assert.equal(row.state, 'queued');
    assert.equal(row.to_peer, '12D3KooWpeerA');
    assert.equal(row.msg_type, 'chat');
    assert.equal(row.attempts, 0);
    const stats = msg.stats();
    assert.equal(stats.queued, 1);
  } finally {
    db.close();
  }
});

test('Phase 5: message IDs are unique; duplicate enqueue is ignored', async () => {
  const { db } = openTmpDb();
  try {
    const msg = new LocalMessaging({ getNode: () => null, db });
    const id = newMsgId();
    await msg.send('peer1', 'data', { n: 1 }, { id });
    await msg.send('peer1', 'data', { n: 2 }, { id }); // same id
    const rows = db.all('SELECT id FROM p2p_outbox WHERE id=?', id);
    assert.equal(rows.length, 1);
  } finally {
    db.close();
  }
});

test('Phase 5: flush with no node leaves messages queued and increments attempts toward max', async () => {
  const { db } = openTmpDb();
  try {
    const msg = new LocalMessaging({ getNode: () => null, db, maxAttempts: 3 });
    const sent = await msg.send('peerX', 'ping', {});
    const r1 = await msg.flush();
    assert.equal(r1.sent, 0);
    assert.equal(r1.remaining, 1);
    // Force next_attempt_at so backoff does not skip the row
    for (let i = 0; i < 5; i++) {
      db.run('UPDATE p2p_outbox SET next_attempt_at=0 WHERE id=?', sent.id);
      await msg.flush();
    }
    const final = msg.stats();
    assert.equal(final.queued, 0);
    assert.ok(final.failed >= 1, 'expected failed after max attempts, got ' + JSON.stringify(final));
  } finally {
    db.close();
  }
});

test('Phase 5: expired messages move to failed, never silently discarded without state', async () => {
  const { db } = openTmpDb();
  try {
    const msg = new LocalMessaging({ getNode: () => null, db, defaultTtlMs: 1 });
    const r = await msg.send('peerY', 'temp', { x: 1 }, { ttlMs: 1 });
    await new Promise((res) => setTimeout(res, 20));
    await msg.flush();
    const row = db.get('SELECT state, last_error FROM p2p_outbox WHERE id=?', r.id);
    assert.ok(row);
    assert.equal(row.state, 'failed');
    assert.equal(row.last_error, 'expired');
  } finally {
    db.close();
  }
});

test('Phase 5: ordering preserved via order_key', async () => {
  const { db } = openTmpDb();
  try {
    const msg = new LocalMessaging({ getNode: () => null, db });
    const a = await msg.send('peerZ', 'a', {});
    const b = await msg.send('peerZ', 'b', {});
    const c = await msg.send('peerZ', 'c', {});
    const pending = msg.listPending(10);
    assert.equal(pending.length, 3);
    assert.ok(pending[0].order_key < pending[1].order_key);
    assert.ok(pending[1].order_key < pending[2].order_key);
  } finally {
    db.close();
  }
});

test('Phase 5: inbox dedup marks seen ids', async () => {
  const { db } = openTmpDb();
  try {
    const msg = new LocalMessaging({ getNode: () => null, db });
    const id = newMsgId();
    assert.equal(msg._hasSeen(id), false);
    msg._markSeen(id);
    assert.equal(msg._hasSeen(id), true);
    // second mark is no-op
    msg._markSeen(id);
    const rows = db.all('SELECT id FROM p2p_inbox_seen WHERE id=?', id);
    assert.equal(rows.length, 1);
  } finally {
    db.close();
  }
});

test('Phase 5: memory fallback works without db', async () => {
  const msg = new LocalMessaging({ getNode: () => null, db: null });
  const r = await msg.send('peerM', 'x', { v: 1 });
  assert.equal(r.status, 'queued');
  assert.equal(msg.pendingCount(), 1);
  const stats = msg.stats();
  assert.equal(stats.queued, 1);
});

test('Phase 5: migration is non-destructive — existing tables remain', () => {
  const { db } = openTmpDb();
  try {
    // baseline tables from earlier migrations
    assert.ok(db.hasTable('schema_migrations'));
    assert.ok(db.hasTable('p2p_outbox'));
    const applied = db.all('SELECT id, name FROM schema_migrations ORDER BY id');
    const ids = applied.map((r) => r.id);
    assert.ok(ids.includes(7));
  } finally {
    db.close();
  }
});
