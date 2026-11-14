'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startHub, Client, tmp } = require('./helpers');
const { createBackup, restoreBackup } = require('../src/backup');
const { openDatabase } = require('../src/db');

const PW = 'correct-horse-9';

test('backup includes posts in DB + data/posts.json inventory', async () => {
  const hub = await startHub({});
  try {
    const c = new Client(hub.base);
    await c.setup('owner', PW);
    const p1 = await c.post('/api/posts', { content: 'Backup test post alpha ' + Date.now() });
    assert.ok([200, 201].includes(p1.status), p1.text);
    const p2 = await c.post('/api/posts', { content: 'Backup test post beta ' + Date.now() });
    assert.ok([200, 201].includes(p2.status), p2.text);

    const dest = tmp('bak-out');
    const r = createBackup(hub.cfg, dest, hub.db);
    assert.ok(r.posts >= 2, 'inventory posts=' + r.posts);
    assert.ok(fs.existsSync(path.join(dest, 'community.db')));
    assert.ok(fs.existsSync(path.join(dest, 'data', 'posts.json')));
    assert.ok(fs.existsSync(path.join(dest, 'data', 'events.json')));
    assert.ok(fs.existsSync(path.join(dest, 'manifest.json')));

    const mf = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
    assert.equal(mf.version, 2);
    assert.ok(mf.inventory.posts >= 2);
    assert.equal(mf.includes.posts_table, true);

    const exportPosts = JSON.parse(fs.readFileSync(path.join(dest, 'data', 'posts.json'), 'utf8'));
    assert.ok(exportPosts.count >= 2);
    assert.ok(exportPosts.posts.some((x) => String(x.content).includes('alpha')));

    // Snapshot DB actually contains posts
    const snap = openDatabase(path.join(dest, 'community.db'), { info() {}, warn() {} });
    try {
      const n = snap.get('SELECT COUNT(*) c FROM posts').c;
      assert.ok(n >= 2, 'snapshot posts=' + n);
    } finally {
      snap.close();
    }
  } finally {
    await hub.stop();
  }
});

test('API backup returns post counts', async () => {
  const hub = await startHub({});
  try {
    const c = new Client(hub.base);
    await c.setup('owner', PW);
    await c.post('/api/posts', { content: 'count me ' + Date.now() });
    const r = await c.post('/api/admin/backup', { password: PW });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.posts >= 1);
    assert.ok(r.json.inventory);
    assert.ok(r.json.download);
  } finally {
    await hub.stop();
  }
});
