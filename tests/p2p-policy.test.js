'use strict';
// Pure policy tests: run everywhere (no libp2p needed). They guard what must hold BEFORE anything reaches libp2p.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path'); const { pathToFileURL } = require('url');
const { parseMultiaddr, checkDial, normalizeListen, denyPrivateHost, DEFAULT_LISTEN } = require('../src/net/p2p/policy');
const { checkModules } = require('../src/net/p2p/availability');

const PID = '12D3KooWRBhwfeP2Y4TCx1SM6s9rUoHhR3zT5xP1Uk9G2dJ9sB9X';

test('multiaddr parser accepts only the supported grammar', () => {
  for (const ok of ['/ip4/127.0.0.1/tcp/4001/ws', '/ip6/::1/tcp/4001/ws', '/dns4/hub.example.com/tcp/443/wss', `/dns/hub.example.com/tcp/443/tls/ws/p2p/${PID}`, `/ip4/8.8.8.8/tcp/80/ws/p2p/${PID}`]) assert.ok(parseMultiaddr(ok), ok);
  assert.equal(parseMultiaddr(`/dns4/a.example/tcp/443/wss/p2p/${PID}`).peerId, PID);
  assert.equal(parseMultiaddr('/ip4/1.2.3.4/tcp/1/tls/ws').secure, true);
});

test('invalid multiaddrs are rejected with a stable code and never throw anything else', () => {
  const longs = '/' + 'a'.repeat(400);
  const bad = ['', ' ', 'garbage', '/', '//', null, undefined, 42, {}, [], true, '/ip4/999.1.1.1/tcp/1/ws', '/ip4/1.2.3.4/tcp/99999/ws', '/ip4/1.2.3.4/tcp/0/ws', '/ip4/1.2.3.4/tcp/01/ws', '/ip4/1.2.3.4/udp/1/ws',
    '/ip4/1.2.3.4/tcp/1', '/ip4/1.2.3.4/tcp/1/quic', '/dns4/exa mple.com/tcp/1/ws', '/dns4/-bad.example/tcp/1/ws', '/dns4/under_score.example/tcp/1/ws', '/ip4/1.2.3.4/tcp/1/ws/extra',
    '/ip4/1.2.3.4/tcp/1/ws/p2p/x', `/ip4/1.2.3.4/tcp/1/ws/p2p/${PID}/more`, '/ip4/1.2.3.4/tcp/1/ws/', '/ip4/1.2.3.4/tcp/1/ws\n', '/ip4/1.2.3.4/tcp/1/ws\0', '/ip4/1.2.3.4//tcp/1/ws', longs, '/ip6/not-an-ip/tcp/1/ws', '/unix/tmp/sock', '/http/x', '/dns4/' + 'a'.repeat(300) + '/tcp/1/ws'];
  for (const a of bad) { try { parseMultiaddr(a); assert.fail('accepted: ' + JSON.stringify(a)); } catch (e) { assert.equal(e.code, 'E_P2P_BAD_ADDR', JSON.stringify(a) + ' -> ' + e.message); } }
});

test('dial policy refuses private/loopback/link-local targets unless explicitly allowed', () => {
  for (const a of ['/ip4/127.0.0.1/tcp/1/ws', '/ip4/10.0.0.5/tcp/1/ws', '/ip4/192.168.1.2/tcp/1/ws', '/ip4/169.254.169.254/tcp/80/ws', '/ip6/::1/tcp/1/ws', '/dns4/localhost/tcp/1/ws', '/dns4/printer.local/tcp/1/ws', '/ip4/100.64.0.1/tcp/1/ws']) {
    assert.throws(() => checkDial(a), (e) => e.code === 'E_P2P_PRIVATE_ADDR', a);
    assert.ok(checkDial(a, { allowPrivate: true }), a + ' allowed on LAN/test mode');
  }
  assert.ok(checkDial('/ip4/8.8.8.8/tcp/443/wss')); assert.ok(checkDial('/dns4/hub.example.com/tcp/443/wss'));
  // connectionGater helper looks only at the host component and never throws on odd shapes
  assert.equal(denyPrivateHost('/ip4/10.1.2.3/tcp/1/ws'), true); assert.equal(denyPrivateHost('/ip4/8.8.8.8/tcp/1/ws'), false);
  assert.equal(denyPrivateHost('/ip4/10.1.2.3/tcp/1/ws', true), false); assert.equal(denyPrivateHost('/p2p/Qm123/p2p-circuit'), false); assert.equal(denyPrivateHost(''), false);
});

test('listen policy: default is ONE loopback ephemeral port; no 0.0.0.0, no HTTP port, no TLS, no DNS', () => {
  assert.deepEqual(normalizeListen([], {}).listen, [DEFAULT_LISTEN]); assert.equal(DEFAULT_LISTEN, '/ip4/127.0.0.1/tcp/0/ws');
  assert.deepEqual(normalizeListen(undefined, {}).listen, [DEFAULT_LISTEN]);
  const r = normalizeListen(['/ip4/0.0.0.0/tcp/0/ws', '/ip6/::/tcp/0/ws', '/ip4/127.0.0.1/tcp/8080/ws', '/ip4/192.168.1.5/tcp/4001/ws', '/dns4/x.example/tcp/1/ws', '/ip4/127.0.0.1/tcp/1/wss', `/ip4/127.0.0.1/tcp/1/ws/p2p/${PID}`, 'junk', '/ip4/127.0.0.1/tcp/0/ws', '/ip4/127.0.0.1/tcp/0/ws'], { httpPort: 8080 });
  assert.deepEqual(r.listen, ['/ip4/127.0.0.1/tcp/0/ws'], 'only the loopback entry survives (deduplicated)');
  assert.deepEqual(r.rejected.map((x) => x.code).sort(), ['E_P2P_BAD_ADDR', 'E_P2P_BAD_ADDR', 'E_P2P_BAD_ADDR', 'E_P2P_BAD_ADDR', 'E_P2P_PORT_CONFLICT', 'E_P2P_PUBLIC_LISTEN', 'E_P2P_PUBLIC_LISTEN', 'E_P2P_PUBLIC_LISTEN'].sort());
  assert.ok(normalizeListen(['/ip4/192.168.1.5/tcp/4001/ws'], { allowPublic: true }).listen.includes('/ip4/192.168.1.5/tcp/4001/ws'), 'explicit opt-in only');
  assert.deepEqual(normalizeListen(['/ip4/0.0.0.0/tcp/8080/ws'], { httpPort: 8080, allowPublic: true }).listen, [DEFAULT_LISTEN], 'even with opt-in the HTTP port is refused');
});

test('module probe uses import(): reports exactly which packages are missing', async () => {
  const seen = [];
  const importer = async (n) => {
    seen.push(n);
    if (n === '@libp2p/noise' || n === 'libp2p') throw Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' });
  };
  const r = await checkModules(importer, ['libp2p', '@libp2p/ping', '@libp2p/noise']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['libp2p', '@libp2p/noise']);
  assert.equal(r.errors.libp2p, 'ERR_MODULE_NOT_FOUND');
  // seen includes REQUIRED names first, then optional capability groups
  assert.ok(seen.includes('libp2p') && seen.includes('@libp2p/ping') && seen.includes('@libp2p/noise'));
  assert.ok('discovery' in r && 'natRelay' in r && 'lan' in r && 'pubsub' in r);
  const allOk = await checkModules(async () => {}, ['a', 'b']);
  assert.equal(allOk.ok, true);
  assert.deepEqual(allOk.missing, []);
  assert.deepEqual(allOk.errors, {});
});

test('regression: require.resolve() cannot detect ESM-only packages, import() can (why the old test gate was unsound)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esmonly-')); const pkg = path.join(dir, 'node_modules', 'fakeesm'); fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'fakeesm', version: '1.0.0', type: 'module', exports: { '.': { import: './index.js' } } }));
  fs.writeFileSync(path.join(pkg, 'index.js'), 'export const ok = true;');
  const req = require('module').createRequire(path.join(dir, 'x.cjs'));
  assert.throws(() => req.resolve('fakeesm'), (e) => e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
  const r = await checkModules((n) => import(pathToFileURL(path.join(dir, 'node_modules', n, 'index.js')).href), ['fakeesm']);
  assert.equal(r.ok, true);
});
