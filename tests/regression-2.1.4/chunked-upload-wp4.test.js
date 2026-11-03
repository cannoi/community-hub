'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startHub, Client, PNG } = require('../helpers');

describe('2.2.0 WP4 chunked upload', () => {
  it('session + chunks + complete assembles a valid PNG', async () => {
    const hub = await startHub({
      maxUploadBytes: 20 * 1024 * 1024,
      userQuotaBytes: 50 * 1024 * 1024,
      rateLimit: { general: 1e5, write: 1e5, login: 1e4, upload: 1e4, federation: 100, assistant: 100 },
    });
    try {
      const c = new Client(hub.base);
      await c.setup('owner');
      // Build ~6MB buffer with PNG header so sniff accepts as png... actually large random with PNG head
      const CHUNK = 5 * 1024 * 1024;
      const size = CHUNK + 1000;
      const buf = Buffer.alloc(size, 7);
      PNG.copy(buf, 0, 0, PNG.length);

      const s = await c.post('/api/media/sessions', { filename: 'big.png', size });
      assert.equal(s.status, 200, s.text);
      assert.equal(s.json.totalChunks, 2);
      assert.equal(s.json.chunkSize, CHUNK);
      const id = s.json.id;

      // chunk 0 full size
      const h = { 'content-type': 'application/octet-stream', 'x-csrf-token': c.csrf };
      if (c.cookie) h.cookie = c.cookie;
      const put0 = await fetch(hub.base + '/api/media/sessions/' + id + '/chunk/0', {
        method: 'PUT', headers: h, body: buf.subarray(0, CHUNK),
      });
      assert.equal(put0.status, 200, await put0.text());

      const put1 = await fetch(hub.base + '/api/media/sessions/' + id + '/chunk/1', {
        method: 'PUT', headers: h, body: buf.subarray(CHUNK),
      });
      assert.equal(put1.status, 200, await put1.text());

      const done = await c.post('/api/media/sessions/' + id + '/complete', {});
      assert.equal(done.status, 200, done.text);
      assert.equal(done.json.kind, 'image');
      assert.equal(done.json.mime, 'image/png');
      assert.equal(done.json.size, size);
      assert.match(done.json.hash, /^[0-9a-f]{64}$/);
    } finally {
      await hub.stop();
    }
  });

  it('rejects oversize session and incomplete complete', async () => {
    const hub = await startHub({ maxUploadBytes: 1024, userQuotaBytes: 1024 * 1024 });
    try {
      const c = new Client(hub.base);
      await c.setup('owner');
      const big = await c.post('/api/media/sessions', { filename: 'x.bin', size: 5000 });
      assert.equal(big.status, 413);
      const s = await c.post('/api/media/sessions', { filename: 'x.png', size: PNG.length });
      assert.equal(s.status, 200);
      const incomplete = await c.post('/api/media/sessions/' + s.json.id + '/complete', {});
      assert.equal(incomplete.status, 400);
    } finally {
      await hub.stop();
    }
  });
});
