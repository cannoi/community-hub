'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { startHub, Client, waitFor } = require('./helpers');
const {
  encryptEnvelope,
  decryptEnvelope,
  isEncryptedEnvelope,
  sanitizeJsonValue,
} = require('../src/net/p2p/bootstrap/cloudflare-crypto');
const { DirectoryClient } = require('../src/net/p2p/bootstrap/directory-client');
const { validateManifest } = require('../src/net/p2p/bootstrap/providers');
const { probePeerRecord } = require('../src/net/p2p/bootstrap/probe');
const { WsGateway } = require('../src/net/p2p/ws-gateway');

const hubs = [];
after(async () => {
  for (const h of hubs) {
    try { await h.stop(); } catch {}
  }
});

describe('Cloudflare encryption + plaintext fallback', () => {
  it('encrypts and decrypts payloads with AES-256-GCM and passes plaintext through when unencrypted', () => {
    const key = 'test-shared-cloudflare-secret-32chars';
    const payload = { network: 'cannoi', peers: [{ peer_id: '12D3KooWTest', multiaddrs: ['/ip4/8.8.8.8/tcp/8181/ws'] }] };
    const env = encryptEnvelope(payload, key);
    assert.equal(isEncryptedEnvelope(env), true);
    assert.equal(env.v, 1);
    assert.equal(env.alg, 'AES-256-GCM');
    assert.ok(env.iv && env.ct);

    const out = decryptEnvelope(env, key);
    assert.equal(out.ok, true);
    assert.deepEqual(out.data, payload);
    assert.equal(out.wasEncrypted, true);

    const wrongOut = decryptEnvelope(env, 'wrong-secret');
    assert.equal(wrongOut.ok, false);
    assert.equal(wrongOut.wasEncrypted, true);
    assert.equal(wrongOut.error, 'decrypt_failed');

    const plain = decryptEnvelope(payload, key);
    assert.equal(plain.ok, true);
    assert.deepEqual(plain.data, payload);
    assert.equal(plain.wasEncrypted, false);
  });

  it('sanitizeJsonValue strips __proto__, constructor, prototype recursively', () => {
    const evil = JSON.parse('{"ok":1,"__proto__":{"polluted":true},"nested":{"constructor":{"prototype":{"x":1}},"safe":"yes"}}');
    const clean = sanitizeJsonValue(evil);
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(clean, '__proto__'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(clean.nested, 'constructor'), false);
    assert.equal(clean.ok, 1);
    assert.equal(clean.nested.safe, 'yes');
  });

  it('DirectoryClient strictly encrypts /p2p/register, decrypts /p2p/bootstrap & register responses, and skips plaintext/wrong-key responses', async () => {
    const { getKey, seal, open } = require('../src/net/p2p/bootstrap/crypto');
    const secret = 'my-cloudflare-worker-key';
    const key = getKey(secret);
    const id = '12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS';
    const regModes = [];
    let bootstrapMode = 'encrypted';

    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/p2p/register' && req.method === 'POST') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          assert.equal(isEncryptedEnvelope(body), true);
          regModes.push('encrypted');
          const dec = open(body, key);
          assert.equal(dec.record.peer_id, id);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(seal({ ok: true, accepted: 1 }, key)));
          return;
        }
        if (req.url === '/p2p/bootstrap') {
          const inner = {
            network: 'cannoi',
            status: 'directory',
            peers: [{
              peer_id: id,
              network: 'cannoi',
              multiaddrs: [`/ip4/203.0.113.20/tcp/8181/ws/p2p/${id}`],
              expires_at: Date.now() + 60000,
            }],
          };
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(bootstrapMode === 'encrypted' ? seal(inner, key) : inner));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const client = new DirectoryClient({
        urls: [`http://127.0.0.1:${port}`],
        cloudflareKey: secret,
        allowPrivate: true,
        timeoutMs: 3000,
      });

      const regOut = await client.register({
        peer_id: id,
        network: 'cannoi',
        multiaddrs: [`/ip4/203.0.113.20/tcp/8181/ws/p2p/${id}`],
      });
      assert.equal(regOut.ok, true);
      assert.equal(regOut.json.accepted, 1);
      assert.deepEqual(regModes, ['encrypted']);

      const encBoot = await client.fetchBootstrap();
      assert.equal(encBoot.peers.length, 1);
      assert.equal(encBoot.peers[0].peerId, id);

      // Zero plaintext fallback: plaintext bootstrap response must be skipped cleanly
      bootstrapMode = 'plaintext';
      const plainBoot = await client.fetchBootstrap();
      assert.equal(plainBoot.peers.length, 0);
      assert.equal(client.status().last_error, 'decrypt_failed');

      // Wrong key must reject encrypted payload cleanly without crashing
      const wrongKeyClient = new DirectoryClient({
        urls: [`http://127.0.0.1:${port}`],
        cloudflareKey: 'wrong-key',
        allowPrivate: true,
        timeoutMs: 3000,
      });
      bootstrapMode = 'encrypted';
      const failed = await wrongKeyClient.fetchBootstrap();
      assert.equal(failed.peers.length, 0);
      assert.equal(wrongKeyClient.status().last_error, 'decrypt_failed');
    } finally {
      server.close();
    }
  });
});

describe('Manifest signature verification & Cloudflare-to-PeerManager auto-sync', () => {
  it('validateManifest verifies Ed25519 signatures when publicKey is provided', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const manifest = {
      version: 1,
      network: 'cannoi',
      expires_at: Date.now() + 60000,
      peers: [{ peer_id: '12D3KooWTestPeer1234567890abcdef', multiaddrs: ['/ip4/8.8.8.8/tcp/8181/ws/p2p/12D3KooWTestPeer1234567890abcdef'] }],
    };
    const canonical = JSON.stringify({
      version: manifest.version,
      network: manifest.network,
      expires_at: manifest.expires_at,
      peers: manifest.peers,
    });
    manifest.signature = crypto.sign(null, Buffer.from(canonical), privateKey).toString('base64');

    const valid = validateManifest(manifest, { publicKey });
    assert.equal(valid.length, 1);
    assert.equal(valid[0].peerId, '12D3KooWTestPeer1234567890abcdef');

    assert.throws(
      () => validateManifest({ ...manifest, signature: Buffer.from('forged').toString('base64') }, { publicKey }),
      /invalid manifest signature/
    );
  });

  it('Hub automatically adds & syncs posts from Cloudflare-discovered peers via _bridgeDiscoveredPeers', async () => {
    const hubA = await startHub({ contentSync: 'trusted', allowPrivatePeers: true, interestScope: 'all', p2p: { enabled: false } });
    const hubB = await startHub({ contentSync: 'trusted', allowPrivatePeers: true, interestScope: 'all', p2p: { enabled: false } });
    hubs.push(hubA, hubB);

    const a = new Client(hubA.base);
    const b = new Client(hubB.base);
    await a.setup('alice', 'correct-horse-9');
    await b.setup('bob', 'correct-horse-9');

    const postRes = await b.post('/api/posts', { content: 'Hello from discovered Cloudflare peer!', visibility: 'public' });
    assert.equal(postRes.status, 201);

    const bAddr = new URL(hubB.base);
    const fakePeerId = '12D3KooWBridgeSyncTest123456789ABCDEFGHJKLMNPQRSTUVWXY';
    const bridged = hubA._bridgeDiscoveredPeers([
      {
        peerId: fakePeerId,
        peer_id: fakePeerId,
        network: 'cannoi',
        multiaddrs: [`/ip4/${bAddr.hostname}/tcp/${bAddr.port}/ws/p2p/${fakePeerId}`],
      },
    ]);
    assert.equal(bridged, 1);

    let row = null;
    try {
      row = await waitFor(() => {
        const p = hubA.db.get("SELECT * FROM peers WHERE endpoint LIKE ?", `%${bAddr.port}%`);
        if (p && p.events_received > 0) return p;
        return null;
      }, 8000);
    } catch (err) {
      const snap = hubA.db.all('SELECT id, endpoint, state, sync_content, last_error, events_received, remote_cursor FROM peers');
      throw new Error(err.message + ' | peers=' + JSON.stringify(snap));
    }
    assert.ok(row, 'Hub A should have synced events from discovered Hub B');

    const feedRes = await a.get('/api/feed/public');
    assert.equal(feedRes.status, 200);
    const items = Array.isArray(feedRes.json) ? feedRes.json : (feedRes.json && feedRes.json.items) || [];
    assert.ok(
      items.some((p) => p.content && p.content.includes('Hello from discovered Cloudflare peer!')),
      'Public post from discovered peer should appear in Hub A feed'
    );
  });
});

describe('Network & Host Hardening', () => {
  it('GET /health does not disclose host public_ip or public_url', async () => {
    const hub = await startHub();
    hubs.push(hub);
    const res = await fetch(hub.base + '/health');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal('public_ip' in data, false);
    assert.equal('public_url' in data, false);
  });

  it('HTTP JSON body parser rejects prototype pollution keys cleanly', async () => {
    const hub = await startHub();
    hubs.push(hub);
    const c = new Client(hub.base);
    await c.setup('alice', 'correct-horse-9');
    const r = await c.post('/api/posts', JSON.parse('{"content":"safe","visibility":"public","__proto__":{"isAdmin":true},"constructor":{"prototype":{"pwned":true}}}'));
    assert.equal(r.status, 201);
    assert.equal(({}).isAdmin, undefined);
    assert.equal(({}).pwned, undefined);
  });

  it('/federation/v1/hello ignores spoofed X-Forwarded-Host when trustProxy is 0', async () => {
    const hub = await startHub({ trustProxy: 0 });
    hubs.push(hub);
    const c = new Client(hub.base);
    await c.setup('alice', 'correct-horse-9');

    const nonce = '1234567890abcdef12345678';
    const res = await fetch(hub.base + `/federation/v1/hello?nonce=${nonce}`, {
      headers: {
        'X-Forwarded-Host': 'evil.attacker:9999',
        'X-Forwarded-Proto': 'https',
      },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.endpoint.includes('evil.attacker'), false);
    assert.equal(data.endpoint, hub.base);
  });

  it('probePeerRecord rejects loopback/private probe targets', async () => {
    const res = await probePeerRecord({
      peer_id: '12D3KooWProbeLoopback1234567890abcdef',
      network: 'cannoi',
      multiaddrs: ['/ip4/127.0.0.1/tcp/8181/ws/p2p/12D3KooWProbeLoopback1234567890abcdef'],
    });
    assert.equal(res.verified, false);
    assert.equal(res.reason, 'unreachable');
  });

  it('WsGateway rejects oversized upgrade head (> 4096 bytes) and enforces per-IP tunnel cap', () => {
    const gw = new WsGateway({
      server: new EventEmitter(),
      getBackend: () => ({ host: '127.0.0.1', port: 65432 }),
      maxPerIp: 2,
    });
    const makeSock = (ip) => {
      const s = new EventEmitter();
      s.remoteAddress = ip;
      s.destroyed = false;
      s.ended = false;
      s.destroy = () => { s.destroyed = true; };
      s.end = () => { s.ended = true; };
      s.write = () => {};
      s.pause = () => {};
      s.resume = () => {};
      return s;
    };

    const bigHeadSock = makeSock('198.51.100.1');
    gw._onUpgrade({
      method: 'GET',
      url: '/p2p/tunnel',
      socket: { remoteAddress: '198.51.100.1' },
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    }, bigHeadSock, Buffer.alloc(5000));
    assert.equal(bigHeadSock.ended, true);

    const makeReq = () => ({
      method: 'GET',
      url: '/p2p/tunnel',
      socket: { remoteAddress: '198.51.100.2' },
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    const s1 = makeSock('198.51.100.2');
    const s2 = makeSock('198.51.100.2');
    const s3 = makeSock('198.51.100.2');
    gw._onUpgrade(makeReq(), s1, Buffer.alloc(0));
    gw._onUpgrade(makeReq(), s2, Buffer.alloc(0));
    gw._onUpgrade(makeReq(), s3, Buffer.alloc(0));
    assert.equal(gw.tunnels.size, 2);
    assert.equal(s3.ended, true);
    gw.close();
  });
});
