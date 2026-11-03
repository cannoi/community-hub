'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { startHub, Client, PNG, formWith, mp4 } = require('../helpers');
const { HttpTransport } = require('../../src/federation/transport');

describe('2.2.0 WP6 media range + knowledge', () => {
  it('serveFile honors Range on local media', async () => {
    const hub = await startHub({
      rateLimit: { general: 1e5, write: 1e5, login: 1e4, upload: 1e4, federation: 100, assistant: 100 },
    });
    try {
      const c = new Client(hub.base);
      await c.setup('owner');
      const up = await c.req('POST', '/api/media', undefined, { form: formWith(PNG, 'x.png') });
      assert.equal(up.status, 200);
      await c.post('/api/posts', { content: 'pic', media: [up.json.hash] });
      const url = hub.base + '/media/' + up.json.hash;
      const r = await fetch(url, { headers: { Range: 'bytes=0-9' } });
      assert.equal(r.status, 206);
      assert.ok(r.headers.get('content-range'));
      const buf = Buffer.from(await r.arrayBuffer());
      assert.equal(buf.length, 10);
      assert.deepEqual(buf, PNG.subarray(0, 10));
    } finally {
      await hub.stop();
    }
  });

  it('HttpTransport.streamProxy is available', () => {
    const t = new HttpTransport({ allowPrivate: true });
    assert.equal(typeof t.streamProxy, 'function');
  });

  it('knowledge manifest topics all have offline replies', () => {
    const A = require('../../src/assistant');
    const man = require('../../knowledge/manifest.json');
    const samples = {
      greet: 'hello', thanks: 'thank you', post: 'how to post', edit_delete: 'delete post',
      follow: 'follow user', media: 'upload photo', groups: 'create group', privacy: 'who can see',
      network: 'connect network', remote: 'public url', backup: 'backup hub', identity: 'account id',
      notifications: 'notifications', search: 'search tags', bookmarks: 'bookmarks',
      settings: 'change language', setup: 'create account setup', dm: 'direct message',
      ai: 'ai provider', feedback: 'send feedback', quota: 'quota limit', offline: 'offline mode',
    };
    for (const topic of man.topics) {
      const msg = samples[topic] || topic;
      const en = A.localReply(msg, 'en');
      assert.ok(en && en.length > 15, 'EN missing for ' + topic);
    }
  });
});
