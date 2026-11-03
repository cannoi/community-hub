'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startHub, Client } = require('../helpers');
const { detectProvider, isPrivateIp, unfurl } = require('../../src/net/unfurl');

describe('2.2.0 WP5 unfurl + embeds', () => {
  it('detects YouTube / Vimeo / TikTok providers', () => {
    const yt = detectProvider('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(yt.provider, 'youtube');
    assert.equal(yt.id, 'dQw4w9WgXcQ');
    assert.match(yt.embedUrl, /youtube-nocookie/);
    const ytb = detectProvider('https://youtu.be/dQw4w9WgXcQ');
    assert.equal(ytb.id, 'dQw4w9WgXcQ');
    const vim = detectProvider('https://vimeo.com/123456789');
    assert.equal(vim.provider, 'vimeo');
    assert.equal(vim.id, '123456789');
    const tt = detectProvider('https://www.tiktok.com/@user/video/7123456789012345678');
    assert.equal(tt.provider, 'tiktok');
  });

  it('blocks private IPs', () => {
    assert.equal(isPrivateIp('127.0.0.1'), true);
    assert.equal(isPrivateIp('10.0.0.5'), true);
    assert.equal(isPrivateIp('192.168.1.1'), true);
    assert.equal(isPrivateIp('8.8.8.8'), false);
  });

  it('API rejects private / bad scheme URLs', async () => {
    const hub = await startHub({});
    try {
      const c = new Client(hub.base);
      await c.setup('owner');
      const priv = await c.get('/api/unfurl?url=' + encodeURIComponent('http://127.0.0.1/'));
      assert.ok(priv.status === 400 || priv.status === 502);
      const ftp = await c.get('/api/unfurl?url=' + encodeURIComponent('ftp://example.com/x'));
      assert.equal(ftp.status, 400);
      const yt = await c.get('/api/unfurl?url=' + encodeURIComponent('https://youtu.be/dQw4w9WgXcQ'));
      assert.equal(yt.status, 200, yt.text);
      assert.equal(yt.json.provider, 'youtube');
      assert.ok(yt.json.embedUrl);
    } finally {
      await hub.stop();
    }
  });

  it('generic Open Graph from public mock server', async () => {
    const mock = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><meta property="og:title" content="Hello OG"/><meta property="og:description" content="Desc"/></head><body>ok</body></html>');
    });
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    const port = mock.address().port;
    // 127.0.0.1 is private — unfurl must reject
    await assert.rejects(() => unfurl('http://127.0.0.1:' + port + '/'), (e) => e.code === 'private_address');
    await new Promise((r) => mock.close(r));
  });
});
