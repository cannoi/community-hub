'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../../src/assistant');
const man = require('../../knowledge/manifest.json');
const adapter = require('../../lib/app-adapter');

describe('2.2.0 WP8 knowledge + offline coverage', () => {
  it('every manifest topic has non-trivial EN and VI offline replies', () => {
    const samples = {
      greet: 'hello', thanks: 'thank you', post: 'how do I post', edit_delete: 'delete post',
      follow: 'follow someone', media: 'upload photo', groups: 'create group', privacy: 'who can see my post',
      network: 'connect to network', remote: 'public url 28090', backup: 'backup hub', identity: 'account id hub1_',
      notifications: 'notifications', search: 'search hashtags', bookmarks: 'bookmarks',
      settings: 'change language', setup: 'create account setup', dm: 'direct message dm',
      ai: 'ai provider api key', feedback: 'send feedback', quota: 'quota limit', offline: 'offline mode',
      embeds: 'youtube embed', chunked: 'large file chunk upload',
    };
    assert.ok(man.topics.length >= 22);
    for (const topic of man.topics) {
      const msg = samples[topic] || topic;
      const en = A.localReply(msg, 'en');
      const vi = A.localReply(msg, 'vi');
      assert.ok(en.length > 25, 'weak EN ' + topic);
      assert.ok(vi.length > 25, 'weak VI ' + topic);
    }
  });

  it('manifest scenarios match offline replies', () => {
    for (const sc of man.scenarios || []) {
      for (const ask of sc.ask) {
        const lang = /[àáạảãâăèéẹêìíòóọôơùúưỳýđ]|xin |toi |ban /i.test(ask) ? 'vi' : 'en';
        const reply = A.localReply(ask, lang).toLowerCase();
        const hit = (sc.mustIncludeAny || []).some((w) => reply.includes(String(w).toLowerCase()));
        assert.ok(hit, sc.id + ' failed for ask=' + ask + ' reply=' + reply.slice(0, 80));
      }
    }
  });

  it('adapter knowledge is secret-free and mentions 2.2 features', () => {
    const k = String(adapter.knowledge || '');
    assert.ok(k.length > 200);
    assert.ok(!/cannoi_|sk-|api[_-]?key\s*[:=]/i.test(k));
    assert.match(k, /28090/);
    assert.match(k, /Chunked|chunk/i);
    assert.match(k, /FAB/i);
  });
});
