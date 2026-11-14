'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const http = require('http'); const net = require('net');
const { spawn } = require('child_process');
const { startHub, Client, tmp, PNG, formWith, waitFor } = require('./helpers');
const { createBackup, restoreBackup } = require('../src/backup');
const { loadConfig } = require('../src/config');

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
function runServer(dataDir, port, extraEnv = {}) {
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', HUB_SCRYPT_N: '1024', NODE_NO_WARNINGS: '1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  child.output = () => out;
  return child;
}
const exited = (c) => new Promise((r) => c.once('exit', (code, sig) => r({ code, sig })));

test('E25/E26 real server process: /health, graceful SIGTERM, data persists across restart', async () => {
  const dir = tmp('proc'); const port = await freePort();
  let child = runServer(dir, port);
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(base + '/health')).status === 200; } catch { return false; } }, 15000);
  const h = await (await fetch(base + '/health')).json(); assert.equal(h.status, 'ok'); assert.ok(h.timestamp);
  const c = new Client(base); const s = await c.setup('owner');
  const up = (await c.req('POST', '/api/media', undefined, { form: formWith(PNG, 'a.png') })).json;
  await c.post('/api/posts', { content: 'persist me', media: [up.hash] });
  child.kill('SIGTERM'); const ex = await exited(child); assert.equal(ex.code, 0, 'graceful shutdown exit code'); assert.match(child.output(), /shutting down/);
  child = runServer(dir, port);
  await waitFor(async () => { try { return (await fetch(base + '/health')).status === 200; } catch { return false; } }, 15000);
  const c2 = new Client(base); await c2.login('owner');
  assert.equal((await c2.get('/api/identity')).json.account_id, s.account_id, 'same identity after restart');
  assert.equal((await c2.get('/api/feed/home')).json.items[0].content, 'persist me');
  assert.equal((await c2.get('/media/' + up.hash, { raw: true })).status, 200);
  assert.ok(!child.output().includes('correct-horse'), 'no secrets in logs');
  child.kill('SIGTERM'); await exited(child);
  // a wrong key passphrase mode change is a clear startup error, not silent key loss
  const bad = runServer(dir, port, { HUB_KEY_PASSPHRASE: 'now-set-passphrase' }); const e = await exited(bad);
  assert.equal(e.code, 1); assert.match(bad.output(), /Keystore was created in "file" mode/);
});

test('E27 backup and restore preserve identity, event history and media; corruption is detected', async () => {
  const A = await startHub(); const c = new Client(A.base); const s = await c.setup('owner');
  const up = (await c.req('POST', '/api/media', undefined, { form: formWith(PNG, 'a.png') })).json;
  await c.post('/api/posts', { content: 'one', media: [up.hash] }); await c.post('/api/posts', { content: 'two #x' });
  const digest = A.ledger.computeDigest();
  const dest = path.join(tmp('bk'), 'b1');
  const r = createBackup(A.cfg, dest, A.db); assert.ok(r.files >= 3);
  await A.stop();
  // restore into a brand new directory
  const dir2 = tmp('restored'); const cfg2 = loadConfig({ DATA_DIR: dir2 });
  restoreBackup(cfg2, dest);
  const B = await startHub({ dataDir: dir2 });
  const c2 = new Client(B.base); await c2.login('owner');
  assert.equal((await c2.get('/api/identity')).json.account_id, s.account_id);
  assert.deepEqual(B.ledger.computeDigest(), digest);
  assert.deepEqual(B.ledger.verifyAll().problems, []);
  assert.equal((await c2.get('/media/' + up.hash, { raw: true })).status, 200);
  const p = await c2.post('/api/posts', { content: 'after restore' }); assert.equal(p.status, 201);
  assert.equal(B.ledger.actorState(s.account_id).last_seq, digest.event_count + 1, 'sequence continues without fork');
  assert.equal(fs.statSync(path.join(dir2, 'keys', 'keystore.json')).mode & 0o777, 0o600);
  await B.stop();
  // refuses to overwrite and detects tampering
  assert.throws(() => restoreBackup(cfg2, dest), /already contains a database/);
  fs.appendFileSync(path.join(dest, 'community.db'), 'x');
  assert.throws(() => restoreBackup(loadConfig({ DATA_DIR: tmp('r3') }), dest), /Checksum mismatch/);
});

test('E27b identity export → import on a fresh Hub recovers the same account; publishing is guarded until history is synced', async () => {
  const A = await startHub(); const c = new Client(A.base); const s = await c.setup('owner');
  await c.post('/api/posts', { content: 'old history' });
  const blob = (await c.post('/api/identity/export', { password: 'correct-horse-9', export_passphrase: 'a-long-passphrase' })).json;
  const B = await startHub(); const d = new Client(B.base);
  assert.equal((await d.post('/api/setup', { username: 'owner', password: 'correct-horse-9', import: { blob, passphrase: 'wrong-passphrase!' } })).status, 400);
  const r = await d.post('/api/setup', { username: 'owner', password: 'correct-horse-9', import: { blob, passphrase: 'a-long-passphrase' } });
  assert.equal(r.json.account_id, s.account_id); assert.equal(r.json.imported, true);
  const blocked = await d.post('/api/posts', { content: 'would fork the chain' });
  assert.equal(blocked.status, 409); assert.equal(blocked.json.code, 'E_HISTORY_NOT_SYNCED');
  // history arrives (here via event import, in practice via peer sync) → publishing continues at the next sequence
  const evs = (await c.get('/api/admin/export/events')).text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal((await d.post('/api/admin/import/events', { events: evs })).json.accepted, evs.length);
  const ok = await d.post('/api/posts', { content: 'continues' }); assert.equal(ok.status, 201);
  assert.equal(B.ledger.actorState(s.account_id).last_seq, evs.length + 1);
  await A.stop(); await B.stop();
});

test('E28/E29 bounded input, safe errors and rate limits', async () => {
  const hub = await startHub({ rateLimit: { general: 100000, write: 30, login: 100, upload: 100, federation: 100, assistant: 20 } });
  const c = new Client(hub.base); await c.setup('owner');
  // body limits and malformed JSON
  const big = await fetch(hub.base + '/api/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: c.cookie, 'x-csrf-token': c.csrf }, body: JSON.stringify({ content: 'x'.repeat(400 * 1024) }) });
  assert.equal(big.status, 413);
  const badj = await fetch(hub.base + '/api/posts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: c.cookie, 'x-csrf-token': c.csrf }, body: '{nope' });
  assert.equal(badj.status, 400);
  assert.equal((await fetch(hub.base + '/api/posts', { method: 'POST', headers: { 'content-type': 'text/plain', cookie: c.cookie, 'x-csrf-token': c.csrf }, body: 'x' })).status, 415);
  assert.equal((await c.post('/api/posts', { content: 'x'.repeat(2001) })).status, 400);
  assert.equal((await c.post('/api/posts', { content: ['array'] })).status, 400);
  assert.equal((await c.post('/api/posts', { content: '   ' })).status, 400);
  // safe error bodies: no stack traces, no file paths
  for (const [m, p] of [['GET', '/nope'], ['GET', '/api/posts/abc'], ['GET', '/api/posts/999999'], ['POST', '/api/health'], ['GET', '/media/zzz'], ['GET', '/..%2f..%2fetc/passwd'], ['GET', '/%00']]) {
    const r = await c.req(m, p, m === 'POST' ? {} : undefined); assert.ok(r.status >= 400 && r.status < 500, `${m} ${p} -> ${r.status}`);
    assert.ok(!/at .*\.js|node_modules|\/home\/|SQLITE|stack/i.test(r.text), 'no internals leaked: ' + r.text);
  }
  // event batches are bounded (only the first 200 are examined) and invalid ones are counted not stored
  const junk = Array.from({ length: 1000 }, (_, i) => ({ schema_version: 1, n: i }));
  const imp = await c.post('/api/admin/import/events', { events: junk }); assert.equal(imp.json.rejected, 200);
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } };
  assert.equal((await c.post('/api/admin/import/events', { events: [{ ...deep }] })).json.rejected, 1);
  // multipart abuse
  const manyFields = new FormData(); for (let i = 0; i < 40; i++) manyFields.append('f' + i, 'v'); manyFields.append('file', new Blob([PNG]), 'a.png');
  assert.equal((await c.req('POST', '/api/media', undefined, { form: manyFields })).status, 400);
  const two = new FormData(); two.append('file', new Blob([PNG]), 'a.png'); two.append('file', new Blob([PNG]), 'b.png');
  assert.equal((await c.req('POST', '/api/media', undefined, { form: two })).status, 400);
  assert.equal((await c.req('POST', '/api/media', undefined, { headers: { 'content-type': 'multipart/form-data; boundary=xx' }, form: undefined })).status, 400);
  // rate limit on writes with Retry-After; reads unaffected
  let limited = null; for (let i = 0; i < 60 && !limited; i++) { const r = await c.get('/api/me'); const w = await c.post('/api/bookmarks/1', {}); if (w.status === 429) limited = w; }
  assert.ok(limited, 'write rate limit triggers'); assert.ok(Number(limited.headers.get('retry-after')) >= 1); assert.equal(limited.json.code, 'E_RATE_LIMIT');
  assert.equal((await c.get('/health')).status, 200);
  // slowloris-style: oversized header line rejected by Node, server stays alive
  await new Promise((resolve) => { const s = net.connect(hub.port, '127.0.0.1', () => { s.write('GET / HTTP/1.1\r\nHost: x\r\nX-Big: ' + 'a'.repeat(70000) + '\r\n\r\n'); }); s.on('data', () => {}); s.on('close', resolve); s.on('error', resolve); setTimeout(() => { s.destroy(); resolve(); }, 1500); });
  assert.equal((await c.get('/health')).status, 200);
  await hub.stop();
});

test('security headers, XSS-safe frontend and static path traversal', async () => {
  const hub = await startHub(); const c = new Client(hub.base);
  const r = await c.get('/', { raw: true });
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/); assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/); assert.match(csp, /frame-src https:\/\/www\.youtube-nocookie\.com/); // embeds only; no script-src third-party
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('access-control-allow-origin'), null, 'no CORS');
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/src/hub.js', '/package.json', '/data/community.db']) assert.equal((await c.get(p, { raw: true })).status, 404, p);
  // no inline scripts/styles/handlers and no third-party hosts in the shipped UI
  const pub = path.join(__dirname, '..', 'public');
  for (const f of fs.readdirSync(pub).filter((x) => /\.(html|js|css)$/.test(x))) {
    const t = fs.readFileSync(path.join(pub, f), 'utf8');
    assert.doesNotMatch(t, /(?:src|href|action)\s*=\s*["']https?:\/\/|url\(\s*["']?https?:\/\/|@import|fetch\(\s*["'`]https?:|import\s.*from\s*["']https?:|new EventSource\(\s*["']https?:|new WebSocket\(/, f + ' loads an external resource');
    if (f.endsWith('.html')) { assert.doesNotMatch(t, /<script(?![^>]*\bsrc=)/); assert.doesNotMatch(t, /\son\w+\s*=|style\s*=/i); }
    if (f.endsWith('.js')) { assert.doesNotMatch(t, /\.innerHTML\s*\+?=(?!\s*(''|""))/, f + ' assigns innerHTML'); assert.doesNotMatch(t, /\beval\(|new Function\(/); }
  }
  await hub.stop();
});

test('E30 dependency / supply-chain check: only allowlisted runtime deps (libp2p stack for Phase 2+)', () => {
  const pkg = require('../package.json');
  const deps = pkg.dependencies || {};
  const allowed = new Set([
    'libp2p',
    '@libp2p/websockets', '@libp2p/noise', '@libp2p/yamux',
    '@libp2p/identify', '@libp2p/ping', '@libp2p/peer-id', '@libp2p/crypto',
  ]);
  for (const name of Object.keys(deps)) {
    assert.ok(allowed.has(name) || name.startsWith('@libp2p/'), 'unexpected runtime dep: ' + name);
  }
  try {
    const lock = require('../package-lock.json');
    assert.equal(lock.name, 'community-hub');
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
  }
  assert.match(pkg.engines.node, />=22/);
});

test('graceful stop closes the database and open event streams', async () => {
  const hub = await startHub(); const c = new Client(hub.base); await c.setup('owner');
  const res = await fetch(hub.base + '/api/stream', { headers: { cookie: c.cookie } });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader(); const first = new TextDecoder().decode((await reader.read()).value); assert.match(first, /event: hello/);
  await c.post('/api/posts', { content: 'live' });
  let got = ''; const t = Date.now(); while (!/event: update/.test(got) && Date.now() - t < 3000) got += new TextDecoder().decode((await reader.read()).value);
  assert.match(got, /event: update/, 'real-time nudge delivered');
  await hub.stop(); assert.equal(hub.db.closed, true);
  assert.throws(() => hub.db.get('SELECT 1'));
});

test('admin: integrity check, reindex and conflicts endpoints work', async () => {
  const hub = await startHub(); const c = new Client(hub.base); await c.setup('owner');
  await c.post('/api/posts', { content: 'a #t' });
  const i = (await c.get('/api/admin/integrity')).json; assert.equal(i.verify.problems.length, 0); assert.ok(i.digest.event_count >= 2);
  hub.db.run('DELETE FROM posts'); hub.db.run('DELETE FROM post_tags');
  assert.equal((await c.get('/api/feed/home')).json.items.length, 0);
  const r = (await c.post('/api/admin/reindex', {})).json; assert.equal(r.digest, i.digest.digest);
  assert.equal((await c.get('/api/feed/home')).json.items.length, 1, 'view rebuilt from the ledger');
  await hub.stop();
});
