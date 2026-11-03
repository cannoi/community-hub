'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { startHub, Client } = require('../helpers');
const { unpackZip } = require('../../src/backup-zip');

describe('2.2.0 backup ZIP download + restore', () => {
  it('creates downloadable zip and restores', async () => {
    const hub = await startHub({});
    try {
      const c = new Client(hub.base);
      await c.setup('owner');
      await c.post('/api/posts', { content: 'zip-backup-test', client_id: cryptoRandom(), visibility: 'public' });
      const r = await c.post('/api/admin/backup', { password: 'correct-horse-9' });
      assert.equal(r.status, 200, r.text);
      assert.match(r.json.download, /\/api\/admin\/backup\/download/);
      const res = await fetch(hub.base + r.json.download, { headers: { cookie: c.cookie } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /zip/);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.ok(buf.length > 100);
      // unpack integrity
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
      fs.writeFileSync(path.join(dir, 'b.zip'), buf);
      const out = path.join(dir, 'out');
      unpackZip(path.join(dir, 'b.zip'), out);
      assert.ok(fs.existsSync(path.join(out, 'manifest.json')));
      assert.ok(fs.existsSync(path.join(out, 'community.db')));

      const form = new FormData();
      form.append('password', 'correct-horse-9');
      form.append('file', new Blob([buf]), 'b.zip');
      const rr = await fetch(hub.base + '/api/admin/restore', {
        method: 'POST',
        headers: { cookie: c.cookie, 'X-CSRF-Token': c.csrf },
        body: form,
      });
      assert.equal(rr.status, 200, await rr.text());
    } finally {
      await hub.stop();
    }
  });
});
function cryptoRandom() {
  return 'c' + Math.random().toString(16).slice(2) + Date.now();
}
