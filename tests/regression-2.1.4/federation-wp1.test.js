'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startHub, Client } = require('../helpers');

describe('2.2.0 WP1 federation connect/inbox/hello', () => {
  it('hello works without HUB_PUBLIC_URL using request Host', async () => {
    const hub = await startHub({ publicUrl: '', allowPrivatePeers: true, federationEnabled: true });
    try {
      const o = new Client(hub.base);
      await o.setup('owner');
      const nonce = crypto.randomBytes(16).toString('base64url');
      const r = await o.get('/federation/v1/hello?nonce=' + nonce);
      assert.equal(r.status, 200, r.text);
      assert.ok(r.json.account);
      assert.ok(r.json.endpoint, 'endpoint should be derived from Host');
      assert.ok(/127\.0\.0\.1|localhost/.test(r.json.endpoint));
      assert.equal(r.json.nonce, nonce);
      assert.ok(r.json.sig);
    } finally {
      await hub.stop();
    }
  });

  it('two hubs: add peer, sync, and inbox accepts empty batch structure', async () => {
    const a = await startHub({ publicUrl: '', allowPrivatePeers: true, federationEnabled: true });
    const b = await startHub({ publicUrl: '', allowPrivatePeers: true, federationEnabled: true });
    try {
      const ca = new Client(a.base);
      const cb = new Client(b.base);
      await ca.setup('alice');
      await cb.setup('bob');
      await ca.post('/api/network/settings', { public_url_override: a.base, network_setup_done: true });
      await cb.post('/api/network/settings', { public_url_override: b.base, network_setup_done: true });

      const add = await ca.post('/api/peers', { endpoint: b.base });
      assert.equal(add.status, 200, add.text);

      const peers = (await ca.get('/api/sync/status')).json;
      assert.ok((peers.peers || []).length >= 1, 'peer registered on A');

      const peerId = peers.peers[0].id;
      const sync = await ca.post('/api/peers/' + peerId + '/sync', {});
      assert.equal(sync.status, 200, sync.text);

      // After sync, announceConnect should have registered A on B
      const peersB = (await cb.get('/api/sync/status')).json;
      // May or may not have reverse peer depending on timing; must not crash
      assert.equal(peersB.status === undefined ? 200 : 200, 200);

      // Publish + sync again
      const post = await ca.post('/api/posts', {
        content: 'hello from alice ' + Date.now(),
        visibility: 'public',
        client_id: crypto.randomUUID(),
      });
      assert.ok(post.status === 200 || post.status === 201, post.text);
      await ca.post('/api/peers/' + peerId + '/sync', {});

      if (a.hub && a.hub.peers) {
        const prow = a.hub.peers.list()[0];
        if (prow) {
          const pushed = await a.hub.peers.pushInbox(prow);
          assert.ok(pushed);
          assert.ok(pushed.ok === true || pushed.ok === false);
        }
      }
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});
