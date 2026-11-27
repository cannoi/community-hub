
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { DirectoryClient } = require('../src/net/p2p/bootstrap/directory-client');
const { createPeerRecord } = require('../src/net/p2p/bootstrap/peer-record');
const { getKey, seal, open } = require('../src/net/p2p/bootstrap/crypto');

const PID = '12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS';

describe('Directory register against mock Worker', () => {
  it('accepts sealed Hub { record } and lists encrypted peer on bootstrap', async () => {
    const store = new Map();
    const secret = 'mock-worker-v140-secret';
    const key = getKey(secret);
    const server = http.createServer((req, res) => {
      const send = (code, obj) => {
        res.statusCode = code;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(seal(obj, key)));
      };
      if (req.method === 'GET' && req.url === '/p2p/bootstrap') {
        const peers = [...store.values()].filter((r) => !r.expires_at || r.expires_at > Date.now());
        return send(200, {
          network: 'cannoi', protocol: '1.0.0', status: 'directory', role: 'rendezvous-seed',
          peer_id: null, multiaddrs: [], peers, count: peers.length, updated_at: new Date().toISOString(),
        });
      }
      if (req.method === 'POST' && req.url === '/p2p/register') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
        req.on('end', () => {
          let j;
          try {
            const raw = JSON.parse(body);
            j = open(raw, key);
          } catch {
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json');
            return res.end(JSON.stringify({ error: 'bad_envelope' }));
          }
          const rec = j.record || j;
          if (!rec || !rec.peer_id || !Array.isArray(rec.multiaddrs) || !rec.multiaddrs.length) {
            return send(400, { error: 'invalid_record' });
          }
          if (rec.network && rec.network !== 'cannoi') return send(400, { error: 'wrong_network' });
          // Reject private-looking multiaddrs (Worker-like)
          const publicMa = rec.multiaddrs.filter((m) => !String(m).includes('/ip4/127.'));
          if (!publicMa.length) return send(400, { error: 'private_address' });
          const saved = { ...rec, multiaddrs: publicMa.slice(0, 8), verified: false };
          store.set(rec.peer_id, saved);
          return send(200, { ok: true, peer_id: rec.peer_id, expires_at: rec.expires_at });
        });
        return;
      }
      send(404, { error: 'not_found' });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const client = new DirectoryClient({ urls: [base], cloudflareKey: secret, timeoutMs: 3000 });

    const record = createPeerRecord({
      peerId: PID,
      multiaddrs: [`/ip4/14.176.78.46/tcp/8181/ws/p2p/${PID}`],
      capabilities: ['hub', 'gossip', 'sync'],
      reachability: 'unknown',
    });
    const reg = await client.register(record);
    assert.equal(reg.ok, true, JSON.stringify(reg));

    const boot = await client.fetchBootstrap();
    assert.equal(boot.peers.length, 1);
    assert.equal(boot.peers[0].peerId, PID);

    // private only must fail sanitize on client list (and server reject)
    const bad = createPeerRecord({
      peerId: PID,
      multiaddrs: [`/ip4/127.0.0.1/tcp/8181/ws/p2p/${PID}`],
      privateLanOk: true,
    });
    const reg2 = await client.register(bad);
    // server rejects private
    assert.equal(reg2.ok, false);

    server.close();
  });
});
