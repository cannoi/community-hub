'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createInvite, parseInvite, normalizePeerInput } = require('../../src/federation/invite');
const { startHub, Client } = require('../helpers');

describe('2.2.0 invite + status redaction', () => {
  it('create/parse invite roundtrip', () => {
    const code = createInvite({ account: 'hub1_bikwpqwon6zx73a3wyofwhoevqiylpqlzmksv2o2nj4gjakxh3pa', endpoints: ['http://203.0.113.10:28090'], name: 'Test' });
    assert.match(code, /^chub1\./);
    const p = parseInvite(code, { allowPrivate: false });
    assert.equal(p.endpoints[0], 'http://203.0.113.10:28090');
    assert.equal(p.account, 'hub1_bikwpqwon6zx73a3wyofwhoevqiylpqlzmksv2o2nj4gjakxh3pa');
    const norm = normalizePeerInput(code, { allowPrivate: false });
    assert.ok(norm.includes('203.0.113.10'));
  });

  it('rejects bad invite', () => {
    assert.throws(() => parseInvite('chub1.not-valid!!!'), (e) => e.code === 'E_INVITE_INVALID');
  });

  it('sync status hides peer endpoint IPs', async () => {
    const hub = await startHub({ allowPrivatePeers: true, publicUrl: 'http://203.0.113.50:28090' });
    try {
      const c = new Client(hub.base);
      await c.setup('owner');
      await c.post('/api/network/settings', { public_url_override: 'http://203.0.113.50:28090' });
      // add a peer via default seed (may fail connect but row exists)
      try { await c.post('/api/peers', { endpoint: 'http://203.0.113.99:28090' }); } catch (_) {}
      const st = await c.get('/api/sync/status');
      assert.equal(st.status, 200, st.text);
      for (const p of st.json.peers || []) {
        assert.equal(p.endpoint, undefined, 'endpoint must not appear in status');
        assert.ok(p.machine_code, 'machine_code required');
        assert.ok(!String(p.machine_code).includes('203.0.113'), 'machine code must not embed IP');
      }
    } finally {
      await hub.stop();
    }
  });
});
