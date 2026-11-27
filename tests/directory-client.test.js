'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { DirectoryClient, sanitizePeer, normalizeUrls } = require('../src/net/p2p/bootstrap/directory-client');
const { getKey, seal } = require('../src/net/p2p/bootstrap/crypto');

describe('DirectoryClient', () => {
  it('normalizeUrls dedupes and keeps http(s)', () => {
    const u = normalizeUrls([
      'https://cannoi-community-bootstrap.huunghitran-datxanh.workers.dev/',
      'https://cannoi-community-bootstrap.huunghitran-datxanh.workers.dev',
      'ftp://bad',
      '',
    ]);
    assert.equal(u.length, 1);
  });

  it('sanitizePeer drops private multiaddrs by default', () => {
    const p = sanitizePeer({
      peer_id: '12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS',
      multiaddrs: ['/ip4/127.0.0.1/tcp/8181/ws/p2p/12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS'],
      network: 'cannoi',
    });
    assert.equal(p, null);
  });

  it('sanitizePeer accepts public multiaddr and normalizes Unix-second expires_at', () => {
    const id = '12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS';
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    const p = sanitizePeer({
      peer_id: id,
      multiaddrs: [`/ip4/14.176.78.46/tcp/8181/ws/p2p/${id}`],
      network: 'cannoi',
      expires_at: futureSec,
    });
    assert.ok(p);
    assert.equal(p.peerId, id);
    assert.ok(p.expires_at > Date.now());
  });

  it('sanitizePeer accepts safe public endpoint when multiaddrs array is empty', () => {
    const id = '12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS';
    const p = sanitizePeer({
      peer_id: id,
      multiaddrs: [],
      endpoint: 'https://hub.example.org',
      network: 'cannoi',
      expires_at: Date.now() + 60000,
    });
    assert.ok(p);
    assert.equal(p.peerId, id);
    assert.equal(p.endpoint, 'https://hub.example.org');
  });

  it('fetchBootstrap against local encrypted mock directory and supports CLOUDFLARE_SYNC_KEY env fallback', async () => {
    const id = '12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS';
    const secret = 'directory-client-test-secret';
    const key = getKey(secret);
    const prevEnv = process.env.CLOUDFLARE_SYNC_KEY;
    process.env.CLOUDFLARE_SYNC_KEY = secret;
    const server = http.createServer((req, res) => {
      if (req.url === '/p2p/bootstrap') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(seal({
          network: 'cannoi', status: 'directory', peer_id: null, multiaddrs: [],
          peers: [{ peer_id: id, network: 'cannoi', multiaddrs: [`/ip4/203.0.113.10/tcp/8181/ws/p2p/${id}`], expires_at: Date.now() + 60000 }],
        }, key)));
        return;
      }
      res.statusCode = 404; res.end();
    });
    try {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address();
      // Empty string cloudflareKey must fall back cleanly to process.env.CLOUDFLARE_SYNC_KEY
      const client = new DirectoryClient({ urls: [`http://127.0.0.1:${port}`], cloudflareKey: '', timeoutMs: 3000 });
      const out = await client.fetchBootstrap();
      assert.equal(out.peers.length, 1);
      assert.equal(out.peers[0].peerId, id);
    } finally {
      if (prevEnv === undefined) delete process.env.CLOUDFLARE_SYNC_KEY;
      else process.env.CLOUDFLARE_SYNC_KEY = prevEnv;
      server.close();
    }
  });
});
