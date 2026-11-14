'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const { startHub, Client } = require('./helpers');

test('SQL injection attempts are inert (search, profile lookup, usernames, cursors, ids)', async () => {
  const hub = await startHub({ allowRegistration: true, rateLimit: { general: 1e5, write: 1e5, login: 1e4, upload: 100, federation: 100, assistant: 20 } });
  const c = new Client(hub.base); await c.setup('owner');
  await c.post('/api/posts', { content: '100% real_post' }); await c.post('/api/posts', { content: 'another one' });
  const bad = ["' OR 1=1 --", '"; DROP TABLE posts; --', "%", "_", "\\", "' UNION SELECT password_hash FROM users --"];
  for (const q of bad) {
    const r = await c.get('/api/search?q=' + encodeURIComponent(q)); assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.json).includes('scrypt$'), 'no hash leaked');
    if (q === '%' || q === '_') assert.ok(r.json.posts.length <= 1, 'LIKE wildcards are escaped: ' + q + ' -> ' + r.json.posts.length);
    assert.equal((await c.get('/api/profiles/' + encodeURIComponent(q))).status, 404);
    assert.ok([400, 401].includes((await new Client(hub.base).post('/api/login', { username: q, password: 'x' + q })).status));
    assert.equal((await c.post('/api/register', { username: q, password: 'abcdefgh1' })).status === 200, false);
  }
  assert.equal((await c.get('/api/feed/public?cursor=' + encodeURIComponent("e30'; DROP TABLE posts;--"))).status, 200);
  for (const id of ["1 OR 1=1", '1;DROP TABLE users', '-1', '0', '9999999999999999999']) assert.ok([400, 404].includes((await c.get('/api/posts/' + encodeURIComponent(id))).status));
  assert.equal(hub.db.get('SELECT COUNT(*) c FROM posts').c, 2); assert.ok(hub.db.hasTable('users'));
  await hub.stop();
});

test('English and Vietnamese dictionaries have identical keys and no empty strings', () => {
  const sandbox = { document: { documentElement: {} }, localStorage: { getItem: () => null, setItem() {} }, navigator: { language: 'en' }, window: {} };
  sandbox.window = sandbox; vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8')
    .replace('const dict = { en, vi };', 'const dict = { en, vi }; window.__dict = dict;');
  vm.runInContext(src, sandbox);
  const { en, vi } = sandbox.__dict;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(vi).sort());
  for (const k of Object.keys(en)) { assert.ok(en[k].length && vi[k].length, k); assert.deepEqual((en[k].match(/\{\w+\}/g) || []).sort(), (vi[k].match(/\{\w+\}/g) || []).sort(), 'placeholders match for ' + k); }
  assert.ok(Object.keys(en).length > 250);
  // every t('…') key used by the UI exists
  const used = new Set();
  for (const f of ['app.js', 'views.js', 'ui.js']) for (const m of fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').matchAll(/\bt\('([A-Za-z0-9_.]+)'/g)) used.add(m[1]);
  const missing = [...used].filter((k) => !k.endsWith('.') && !(k in en)); assert.deepEqual(missing, []);
  const dynamic = { 'vis.': ['public', 'followers', 'group'], 'notif.': ['like', 'reply', 'repost', 'quote', 'follow'], 'groups.role.': ['admin', 'member'], 'net.health.': ['healthy', 'degraded', 'offline', 'pending', 'blocked'], 'assistant.': ['s1', 's2', 's3', 's4'] };
  for (const [prefix, vals] of Object.entries(dynamic)) for (const x of vals) assert.ok((prefix + x) in en && (prefix + x) in vi, prefix + x);
});
