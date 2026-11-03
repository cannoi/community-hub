'use strict';
/**
 * Browser-free end-to-end API journey (WP9-lite): setup → network → post → unfurl → assistant → feedback auth.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startHub, Client } = require('../helpers');

describe('2.2.0 WP9-lite API user journey', () => {
  it('owner completes core happy path', async () => {
    const hub = await startHub({
      allowPrivatePeers: true,
      rateLimit: { general: 1e5, write: 1e5, login: 1e4, upload: 1e4, federation: 100, assistant: 100 },
    });
    try {
      const c = new Client(hub.base);

      // 1) Setup account
      const setup = await c.setup('journey_owner');
      assert.ok(setup.user || setup.account_id || (await c.get('/api/session')).json.user);

      const session = (await c.get('/api/session')).json;
      assert.ok(session.user);

      // 2) Network settings — mark setup done without relying on removed hard-coded IP seed
      // (intro_peer: 'default' is intentionally rejected after Global Presence removed built-in IPs)
      const ns = await c.post('/api/network/settings', { network_setup_done: true, skip_network: true });
      assert.ok(ns.status === 200 || ns.status === 204, ns.text || String(ns.status));

      // 3) Remote info is owner-only OK
      const remote = await c.get('/api/remote/info');
      assert.equal(remote.status, 200);

      // 4) Anonymous remote denied
      const anon = new Client(hub.base);
      assert.equal((await anon.get('/api/remote/info')).status, 401);

      // 5) Post + AI offline help
      const post = await c.post('/api/posts', {
        content: 'Journey hello https://youtu.be/dQw4w9WgXcQ',
        visibility: 'public',
        client_id: crypto.randomUUID(),
      });
      assert.ok(post.status === 200 || post.status === 201, post.text);

      const chat = await c.post('/api/ai/chat', { message: 'How do I follow someone?' });
      assert.equal(chat.status, 200);
      assert.equal(chat.json.provider, 'local');
      assert.match(chat.json.reply, /Follow|Theo dõi/i);

      // 6) Unfurl youtube
      const uf = await c.get('/api/unfurl?url=' + encodeURIComponent('https://youtu.be/dQw4w9WgXcQ'));
      assert.equal(uf.status, 200);
      assert.equal(uf.json.provider, 'youtube');

      // 7) Feedback requires auth (anonymous blocked)
      assert.equal((await anon.post('/api/feedback', { type: 'bug', message: 'x' })).status, 401);

      // 8) AI status anonymous is minimal
      const st = await anon.get('/api/ai/status');
      assert.equal(st.status, 200);
      assert.equal(typeof st.json.configured, 'boolean');
      assert.equal(st.json.settings, undefined);
    } finally {
      await hub.stop();
    }
  });
});
