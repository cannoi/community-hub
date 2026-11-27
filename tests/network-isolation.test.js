'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startHub, Client } = require('./helpers');
const { getKey, seal } = require('../src/net/p2p/bootstrap/crypto');
const { Libp2pAdapter } = require('../src/net/p2p/libp2p-adapter');

const hubs = [];
after(async () => {
  for (const h of hubs) {
    try { await h.stop(); } catch {}
  }
});

describe('Cloudflare directory contacts sync & Private Network community isolation', () => {
  it('syncs contacts from Cloudflare Worker (encrypted v1.4.0), bridges peer, and exposes remote contact in DM', async () => {
    const secret = 'cf-sync-isolation-secret-1';
    const key = getKey(secret);
    const peerBId = '12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS';

    // Start target Hub B first
    const hubB = await startHub({
      allowRegistration: false,
      allowPrivatePeers: true,
      p2p: { enabled: false },
    });
    hubs.push(hubB);
    const bobClient = new Client(hubB.base);
    await bobClient.setup('bob_cf', 'correct-horse-9', { display_name: 'Bob Community' });
    hubB.cfg.publicUrl = hubB.base;

    // Mock encrypted Cloudflare Worker directory returning Hub B via multiaddr + endpoint
    const uB = new URL(hubB.base);
    const worker = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/p2p/bootstrap') {
        return res.end(JSON.stringify(seal({
          network: 'cannoi',
          status: 'directory',
          data: {
            peers: [
              {
                peer_id: peerBId,
                network: 'cannoi',
                endpoint: hubB.base,
                multiaddrs: [`/ip4/${uB.hostname}/tcp/${uB.port}/ws/p2p/${peerBId}`],
                name: 'Bob Community Hub',
                expires_at: Math.floor(Date.now() / 1000) + 3600,
              },
            ],
          },
        }, key)));
      }
      if (req.method === 'POST' && req.url === '/p2p/register') {
        return res.end(JSON.stringify(seal({ ok: true, accepted: 1 }, key)));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise((r) => worker.listen(0, '127.0.0.1', r));
    const workerUrl = `http://127.0.0.1:${worker.address().port}`;

    try {
      const hubA = await startHub({
        allowRegistration: false,
        allowPrivatePeers: true,
        p2p: {
          enabled: false,
          directorySeeds: [workerUrl],
          fixedSeeds: [],
          cloudflareKey: secret,
        },
      });
      hubs.push(hubA);
      const aliceClient = new Client(hubA.base);
      await aliceClient.setup('alice_cf', 'correct-horse-9', { display_name: 'Alice Sync' });
      hubA.cfg.publicUrl = hubA.base;

      // Trigger manual Cloudflare directory sync ("Đồng bộ danh bạ ngay")
      const syncRes = await aliceClient.post('/api/network/directory/sync', {});
      assert.equal(syncRes.status, 200, JSON.stringify(syncRes.json));
      assert.equal(syncRes.json.ok, true);
      assert.equal(syncRes.json.count, 1);
      assert.ok(syncRes.json.bridged >= 1);

      // Give peer handshake/sync a brief moment to complete
      await new Promise((r) => setTimeout(r, 150));

      // Verify Hub B was bridged into peers and materialized as remote DM contact
      const hubBAccount = hubB.peers.self().account;
      const peersRes = await aliceClient.get('/api/peers');
      assert.equal(peersRes.status, 200);
      assert.ok(
        peersRes.json.items.some((p) => p.account_id === hubBAccount || p.name === 'Bob Community Hub'),
        `bridged peer should be in peers table, got: ${JSON.stringify(peersRes.json.items)}`
      );

      const dmRes = await aliceClient.get('/api/messages/threads');
      assert.equal(dmRes.status, 200);
      const hasBob = (dmRes.json.contacts || []).some((c) => c.account_id === hubBAccount && c.status === 'remote');
      assert.ok(hasBob, `Expected remote contact from Cloudflare sync in DM contacts, got: ${JSON.stringify(dmRes.json.contacts)}`);
    } finally {
      await new Promise((r) => worker.close(r));
    }
  });

  it('Libp2pAdapter.refreshPublicEndpoint calls _refreshLocalRecord and _publishLocalRecord without throwing', async () => {
    const adapter = new Libp2pAdapter({
      cfg: { publicUrl: 'http://198.51.100.12:8181', p2p: { wsGateway: true, publicPort: 8181 } },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    adapter._peerId = '12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS';
    let refreshed = 0;
    let published = 0;
    adapter._bootstrap = {
      _refreshLocalRecord() { refreshed++; },
      async _publishLocalRecord() { published++; },
    };
    const addrs = adapter.refreshPublicEndpoint({ publicUrl: 'https://hub.example.org' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(refreshed, 1);
    assert.equal(published, 1);
    assert.ok(addrs[0].includes('/dns4/hub.example.org/'));
  });

  it('detects active community participation, disconnects community peers on private switch, and rejects community Hubs while allowing private Hubs', async () => {
    const hubPriv = await startHub({
      allowRegistration: false,
      allowPrivatePeers: true,
      p2p: { enabled: false },
    });
    hubs.push(hubPriv);
    const privOwner = new Client(hubPriv.base);
    await privOwner.setup('priv_owner', 'correct-horse-9');
    hubPriv.cfg.publicUrl = hubPriv.base;

    const hubComm = await startHub({
      allowRegistration: false,
      allowPrivatePeers: true,
      p2p: { enabled: false },
    });
    hubs.push(hubComm);
    const commOwner = new Client(hubComm.base);
    await commOwner.setup('comm_owner', 'correct-horse-9');
    hubComm.cfg.publicUrl = hubComm.base;

    const hubPriv2 = await startHub({
      allowRegistration: false,
      allowPrivatePeers: true,
      p2p: { enabled: false },
    });
    hubs.push(hubPriv2);
    const priv2Owner = new Client(hubPriv2.base);
    await priv2Owner.setup('priv2_owner', 'correct-horse-9');
    hubPriv2.cfg.publicUrl = hubPriv2.base;

    // Seed a bootstrap community peer on hubPriv so community_status detects active community membership
    hubPriv.peers.add('https://community-seed.example.org', { state: 'bootstrap', name: 'community-seed' });

    const statusBefore = await privOwner.get('/api/network/settings');
    assert.equal(statusBefore.status, 200);
    assert.equal(statusBefore.json.network_mode, 'community');
    assert.equal(statusBefore.json.community_status.community_active, true);
    assert.ok(statusBefore.json.community_status.community_peers_count >= 1);

    // Switch hubPriv -> Private Network
    const switchRes = await privOwner.post('/api/network/settings', { network_join: false });
    assert.equal(switchRes.status, 200);
    assert.equal(switchRes.json.network_mode, 'private');
    assert.equal(switchRes.json.was_community, true);
    assert.ok(switchRes.json.disconnected_community_peers >= 1);

    // Verify public directory sync is blocked in Private mode
    const dirSyncInPrivate = await privOwner.post('/api/network/directory/sync', {});
    assert.equal(dirSyncInPrivate.status, 409);
    assert.equal(dirSyncInPrivate.json.code, 'E_PRIVATE_MODE');

    // Switch hubPriv2 -> Private Network as well
    const switchRes2 = await priv2Owner.post('/api/network/settings', { network_join: false });
    assert.equal(switchRes2.status, 200);
    assert.equal(switchRes2.json.network_mode, 'private');

    // 1) hubPriv tries to add hubComm (still on community network) -> 403 E_COMMUNITY_HUB_REJECTED
    const addCommRes = await privOwner.post('/api/peers', { endpoint: hubComm.base });
    assert.equal(addCommRes.status, 403, JSON.stringify(addCommRes.json));
    assert.equal(addCommRes.json.code, 'E_COMMUNITY_HUB_REJECTED');

    // 2) hubPriv (private) handshakes with hubComm (community) -> throws E_COMMUNITY_HUB_REJECTED
    const peerEntryOnPriv = hubPriv.peers.add(hubComm.base, { state: 'bootstrap', name: 'comm-target' });
    let rejectedByHandshake = false;
    try {
      await hubPriv.peers.handshake(peerEntryOnPriv);
    } catch (e) {
      if (e && e.code === 'E_COMMUNITY_HUB_REJECTED') rejectedByHandshake = true;
    }
    assert.equal(rejectedByHandshake, true, 'Private Hub must reject handshake from community Hub');
    hubPriv.peers.remove(peerEntryOnPriv.id);

    // Also hubComm (community) calling /federation/v1/connect on hubPriv (private) -> 403 E_COMMUNITY_HUB_REJECTED

    const hubPrivAccount = hubPriv.peers.self().account;
    let connectRejected = null;
    try {
      await hubComm.peers.call(
        { endpoint: hubPriv.base, account_id: hubPrivAccount },
        'POST',
        '/federation/v1/connect',
        { endpoint: hubComm.base, name: 'Community Hub', network_mode: 'community' }
      );
    } catch (e) {
      connectRejected = e;
    }
    assert.ok(connectRejected, 'Expected /federation/v1/connect from community Hub to reject');
    assert.equal(connectRejected.status, 403);
    assert.equal(connectRejected.code, 'E_COMMUNITY_HUB_REJECTED');

    // 3) hubPriv connects with hubPriv2 (another Private Hub) -> succeeds!
    const addPriv2 = await privOwner.post('/api/peers', { endpoint: hubPriv2.base });
    assert.equal(addPriv2.status, 200, JSON.stringify(addPriv2.json));
    const okJson = await hubPriv2.peers.call(
      { endpoint: hubPriv.base, account_id: hubPrivAccount },
      'POST',
      '/federation/v1/connect',
      { endpoint: hubPriv2.base, name: 'Private Hub 2', network_mode: 'private' }
    );
    assert.equal(okJson.ok, true);
    assert.equal(okJson.network_mode, 'private');
  });
});
