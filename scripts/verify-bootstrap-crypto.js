#!/usr/bin/env node
'use strict';
/**
 * Verification script for Worker v1.4.0 AES-256-GCM Bootstrap Crypto.
 * Checks key derivation, seal/open/openOrPlain, tamper/wrong-key rejection,
 * strict fixed-seed provider decryption, encrypted /p2p/register + response,
 * and graceful seed skip without plaintext fallback.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const { getKey, seal, open, openOrPlain } = require('../src/net/p2p/bootstrap/crypto');
const { createFixedSeedProvider, publishPeerRecord } = require('../src/net/p2p/bootstrap/providers');
const { DirectoryClient } = require('../src/net/p2p/bootstrap/directory-client');
const { BootstrapManager } = require('../src/net/p2p/bootstrap/manager');

async function main() {
  const prevEnv = process.env.CLOUDFLARE_SYNC_KEY;
  const secret = 'verify-bootstrap-crypto-secret-key-2026';

  // 1. Key derivation matches SHA-256(utf8(CLOUDFLARE_SYNC_KEY))
  delete process.env.CLOUDFLARE_SYNC_KEY;
  assert.throws(() => getKey(), /CLOUDFLARE_SYNC_KEY/);
  process.env.CLOUDFLARE_SYNC_KEY = secret;
  const key = getKey();
  assert.equal(Buffer.isBuffer(key), true);
  assert.equal(key.length, 32);
  const expected = crypto.createHash('sha256').update(Buffer.from(secret, 'utf8')).digest();
  assert.deepEqual(key, expected);

  // 2. seal() & open() match AES-256-GCM + 12-byte IV + ct = ciphertext||authTag
  const sample = {
    network: 'cannoi',
    status: 'directory',
    peers: [{ peer_id: '12D3KooWVerifyPeer123456789ABCDEFGHJKLMNPQRSTUVWXY', multiaddrs: ['/ip4/8.8.8.8/tcp/8181/ws/p2p/12D3KooWVerifyPeer123456789ABCDEFGHJKLMNPQRSTUVWXY'] }],
  };
  const env = seal(sample);
  assert.equal(env.encrypted, true);
  assert.equal(env.v, 1);
  assert.equal(env.alg, 'AES-256-GCM');
  assert.equal(Buffer.from(env.iv, 'base64').length, 12);
  const ctBuf = Buffer.from(env.ct, 'base64');
  assert.equal(ctBuf.length, Buffer.byteLength(JSON.stringify(sample), 'utf8') + 16);

  const opened = open(env);
  assert.deepEqual(opened, sample);

  // 3. Rejects plaintext, wrong key, and tampered ciphertext
  assert.throws(() => open(sample), /encrypted/i);
  assert.throws(() => open(env, 'wrong-secret-key'));
  const tampered = Buffer.from(env.ct, 'base64');
  tampered[0] ^= 0xff;
  assert.throws(() => open({ ...env, ct: tampered.toString('base64') }));

  // 4. openOrPlain behavior
  assert.deepEqual(openOrPlain(env), sample);
  assert.deepEqual(openOrPlain(sample), sample);
  assert.throws(() => openOrPlain({ ...env, ct: tampered.toString('base64') }));

  // 5. End-to-end Worker v1.4.0 mock server (fixed seed + register + broken seed skip)
  const peerId = '12D3KooWBootstrapVerify123456789ABCDEFGHJKLMNPQRSTUVWXY';
  let sawEncryptedReg = false;
  const goodServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/p2p/bootstrap' && req.method === 'GET') {
        res.end(JSON.stringify(seal({
          network: 'cannoi',
          protocol: '1',
          status: 'directory',
          multiaddrs: [],
          peers: [{
            network: 'cannoi',
            peer_id: peerId,
            multiaddrs: [`/ip4/8.8.8.8/tcp/8181/ws/p2p/${peerId}`],
            expires_at: Date.now() + 60000,
          }],
        })));
        return;
      }
      if (req.url === '/p2p/register' && req.method === 'POST') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const dec = open(body);
        assert.ok(dec.record && dec.record.peer_id === peerId);
        sawEncryptedReg = true;
        res.end(JSON.stringify(seal({ ok: true, accepted: 1, peer_id: dec.record.peer_id })));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });

  // Broken/plaintext seed that MUST be skipped without plaintext fallback or crash
  const plainBadServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      network: 'cannoi',
      peer_id: '12D3KooWPlainShouldBeIgnored123456789ABCDEFGHJKLMN',
      multiaddrs: ['/ip4/8.8.8.8/tcp/8181/ws/p2p/12D3KooWPlainShouldBeIgnored123456789ABCDEFGHJKLMN'],
    }));
  });

  await Promise.all([
    new Promise((r) => goodServer.listen(0, '127.0.0.1', r)),
    new Promise((r) => plainBadServer.listen(0, '127.0.0.1', r)),
  ]);
  const goodUrl = `http://127.0.0.1:${goodServer.address().port}`;
  const badUrl = `http://127.0.0.1:${plainBadServer.address().port}`;

  try {
    const provider = createFixedSeedProvider([badUrl, goodUrl], { cloudflareKey: secret, allowPrivate: true });
    const discovered = await provider.discover();
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].peerId, peerId);

    const regRes = await publishPeerRecord(goodUrl, {
      peer_id: peerId,
      network: 'cannoi',
      multiaddrs: [`/ip4/8.8.8.8/tcp/8181/ws/p2p/${peerId}`],
      expires_at: Date.now() + 60000,
    }, 3000, { cloudflareKey: secret, allowPrivate: true });
    assert.equal(sawEncryptedReg, true);
    assert.equal(regRes.ok, true);
    assert.equal(regRes.accepted, 1);

    // Reject plaintext register server (never falls back)
    await assert.rejects(() => publishPeerRecord(badUrl, {
      peer_id: peerId,
      network: 'cannoi',
      multiaddrs: [`/ip4/8.8.8.8/tcp/8181/ws/p2p/${peerId}`],
    }, 2000, { cloudflareKey: secret, allowPrivate: true }));

    // DirectoryClient strictly uses encrypted bootstrap & register
    const dir = new DirectoryClient({ urls: [badUrl, goodUrl], cloudflareKey: secret, allowPrivate: true });
    const dirBoot = await dir.fetchBootstrap();
    assert.equal(dirBoot.peers.length, 1);
    assert.equal(dirBoot.peers[0].peerId, peerId);

    // BootstrapManager has 10-minute refresh interval configured
    const mgr = new BootstrapManager({ cfg: { fixedSeeds: [badUrl, goodUrl], cloudflareKey: secret, allowPrivate: true } });
    assert.equal(mgr._refreshIntervalMs, 10 * 60 * 1000);
  } finally {
    await new Promise((r) => goodServer.close(r));
    await new Promise((r) => plainBadServer.close(r));
    if (prevEnv === undefined) delete process.env.CLOUDFLARE_SYNC_KEY;
    else process.env.CLOUDFLARE_SYNC_KEY = prevEnv;
  }

  console.log('verify-bootstrap-crypto: ALL PASSED');
}

main().catch((err) => {
  console.error('verify-bootstrap-crypto FAILED:', err);
  process.exit(1);
});
