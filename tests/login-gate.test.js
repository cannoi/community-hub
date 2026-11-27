'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startHub, Client } = require('./helpers');

const PW = 'correct-horse-9';

test('session exposes password-only login hint for single local user', async () => {
  const hub = await startHub({});
  try {
    const c = new Client(hub.base);
    await c.setup('owner', PW);
    await c.post('/api/logout', {});
    const sess = await c.get('/api/session');
    assert.equal(sess.status, 200);
    assert.ok(sess.json.login);
    assert.equal(sess.json.login.mode, 'password');
    assert.equal(sess.json.login.username, 'owner');
  } finally {
    await hub.stop();
  }
});

test('password-only login succeeds for single-owner Hub (PAI style)', async () => {
  const hub = await startHub({});
  try {
    const c = new Client(hub.base);
    await c.setup('owner', PW);
    await c.post('/api/logout', {});
    const r = await c.post('/api/login', { password: PW });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.user);
    assert.equal(r.json.user.username, 'owner');
    assert.ok(r.json.csrf);
    // session cookie works
    const sess = await c.get('/api/session');
    assert.ok(sess.json.user);
  } finally {
    await hub.stop();
  }
});

test('password-only login rejects wrong password', async () => {
  const hub = await startHub({});
  try {
    const c = new Client(hub.base);
    await c.setup('owner', PW);
    await c.post('/api/logout', {});
    const r = await c.post('/api/login', { password: 'wrong-password-xx' });
    assert.equal(r.status, 401);
  } finally {
    await hub.stop();
  }
});

test('cookie header uses SameSite=Lax (Pi Browser friendly)', async () => {
  const hub = await startHub({});
  try {
    const c = new Client(hub.base);
    const r = await c.setup('owner', PW);
    // Client may not expose raw set-cookie; hit login and inspect via raw if available
    await c.post('/api/logout', {});
    // Use plain fetch through client base
    const http = require('http');
    const url = new URL(hub.base + '/api/login');
    const body = JSON.stringify({ password: PW });
    const headers = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname, port: url.port, path: url.pathname,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        const set = res.headers['set-cookie'] || [];
        res.resume();
        resolve(set);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    const joined = headers.join(';');
    assert.ok(/SameSite=Lax/i.test(joined), 'expected SameSite=Lax, got ' + joined);
    assert.ok(/HttpOnly/i.test(joined));
    assert.ok(/hub_session=/i.test(joined));
  } finally {
    await hub.stop();
  }
});
