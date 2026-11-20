'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startHub, Client } = require('./helpers');

const PW = 'correct-horse-9';

test('login returns session token usable via X-Hub-Session without cookie', async () => {
  const hub = await startHub({});
  try {
    const c = new Client(hub.base);
    await c.setup('owner', PW);
    await c.post('/api/logout', {});

    const url = new URL(hub.base + '/api/login');
    const body = JSON.stringify({ password: PW });
    const login = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let d = ''; res.on('data', (x) => d += x);
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d), setCookie: res.headers['set-cookie'] }));
      });
      req.on('error', reject); req.write(body); req.end();
    });
    assert.equal(login.status, 200);
    assert.ok(login.json.session, 'session token in body');
    assert.ok(login.json.csrf);

    // Call session WITH header only (no Cookie)
    const sess = await new Promise((resolve, reject) => {
      const u = new URL(hub.base + '/api/session');
      const req = http.request({
        hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
        headers: { 'X-Hub-Session': login.json.session },
      }, (res) => {
        let d = ''; res.on('data', (x) => d += x);
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(sess.status, 200);
    assert.ok(sess.json.user);
    assert.equal(sess.json.user.username, 'owner');
  } finally {
    await hub.stop();
  }
});
