'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const compat = require('../src/net/p2p/libp2p-compat');
const { Libp2pAdapter } = require('../src/net/p2p/libp2p-adapter');
const { LocalMessaging } = require('../src/net/p2p/local-messaging');

const PID = '12D3KooWbootstrapTest123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ADDR = `/ip4/14.176.78.46/tcp/8181/ws/p2p/${PID}`;
// Fake of the libp2p 3.x contract: Multiaddr objects have getComponents(); strings do not.
class FakeMultiaddr { constructor(s) { this.s = s; } getComponents() { return this.s.split('/').filter(Boolean); } toString() { return this.s; } }
const importer = async (name) => {
  if (name === '@multiformats/multiaddr') return { multiaddr: (s) => new FakeMultiaddr(s) };
  if (name === '@libp2p/peer-id') return { peerIdFromString: (s) => ({ type: 'Ed25519', toString: () => s }) };
  throw new Error('not installed: ' + name);
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

test('toMultiaddr: strings become Multiaddr objects, objects and arrays pass through, junk is rejected', async () => {
  const m = await compat.toMultiaddr(ADDR, importer);
  assert.ok(m instanceof FakeMultiaddr); assert.equal(String(m), ADDR);
  assert.equal(await compat.toMultiaddr(m, importer), m);
  const arr = await compat.toMultiaddr([ADDR, m], importer); assert.equal(arr.length, 2); assert.ok(arr.every((x) => typeof x.getComponents === 'function'));
  await assert.rejects(() => compat.toMultiaddr('not-an-address', importer), { code: 'E_P2P_BAD_ADDR' });
  await assert.rejects(() => compat.toMultiaddr(ADDR, async () => { throw new Error('nope'); }), { code: 'E_P2P_MODULES' });
});

test('adapter._dialSafe never hands a string to libp2p 3.x (regression: multiaddrs[0].getComponents is not a function)', async () => {
  const adapter = new Libp2pAdapter({ cfg: { p2p: {} }, log: quiet, importModule: importer });
  const dialed = [];
  adapter._node = { dial: async (arg) => { if (typeof arg.getComponents !== 'function') throw new TypeError('multiaddrs[0].getComponents is not a function'); dialed.push(String(arg)); } };
  await adapter._dialSafe(ADDR);
  assert.deepEqual(dialed, [ADDR]); assert.equal(adapter._lastDialError, null);
  // the exact failure of 2.3.15 for comparison
  const old = new Libp2pAdapter({ cfg: { p2p: {} }, log: quiet, importModule: importer });
  old._node = { dial: async (arg) => { if (typeof arg === 'string') throw new TypeError('multiaddrs[0].getComponents is not a function'); } };
  await old._dialSafe(ADDR);   // converted: no error
  // a missing @multiformats/multiaddr package produces a clear, specific error (not the cryptic one)
  const broken = new Libp2pAdapter({ cfg: { p2p: {} }, log: quiet, importModule: async () => { throw new Error('Cannot find package'); } });
  broken._node = { dial: async () => {} };
  await assert.rejects(() => broken._dialSafe(ADDR), (e) => e.code === 'E_P2P_MODULES' && /multiaddr/.test(e.message));
  assert.match(broken._lastDialError, /@multiformats\/multiaddr/);
});

test('handlerArgs / readStream / writeStream accept both libp2p 2.x and 3.x shapes', async () => {
  const s2 = { stream: { id: 2 }, connection: { id: 'c' } };
  assert.deepEqual(compat.handlerArgs(s2), { stream: s2.stream, connection: s2.connection });
  const s3 = { id: 3 }; assert.deepEqual(compat.handlerArgs(s3, { id: 'c3' }), { stream: s3, connection: { id: 'c3' } });
  async function* gen(...parts) { for (const p of parts) yield p; }
  const v2 = { source: gen(Buffer.from('he'), { subarray: () => Buffer.from('llo') }) };
  assert.equal((await compat.readStream(v2)).toString(), 'hello');
  const v3 = gen(new Uint8Array(Buffer.from('v3!')));
  assert.equal((await compat.readStream(v3)).toString(), 'v3!');
  await assert.rejects(() => compat.readStream(gen(Buffer.alloc(100)), 50), { code: 'E_P2P_TOO_LARGE' });
  const sent = []; await compat.writeStream({ sink: async (a) => sent.push(...a) }, Buffer.from('a')); await compat.writeStream({ send: (d) => { sent.push(d); return true; } }, Buffer.from('b'));
  assert.deepEqual(sent.map(String), ['a', 'b']);
  let drained = false; await compat.writeStream({ send: () => false, onDrain: async () => { drained = true; } }, Buffer.from('c')); assert.ok(drained);
});

test('local messaging: dialProtocol receives a PeerId object, v3 stream is written with send(), inbound size is bounded', async () => {
  const calls = []; let handler = null;
  const stream = { send(d) { calls.push(['send', Buffer.from(d).toString()]); return true; }, async close() { calls.push(['close']); } };
  const node = { handle: async (_p, h) => { handler = h; }, dialProtocol: async (peer, proto) => { calls.push(['dial', typeof peer, proto]); return stream; } };
  const lm = new LocalMessaging({ getNode: () => node, log: quiet, localPeerId: () => 'me', toPeer: (id) => compat.toPeerId(id, importer), maxMessageBytes: 200 });
  await lm.start();
  const r = await lm.send(PID, 'chat', { t: 'hi' });
  assert.equal(r.status, 'sent');
  assert.deepEqual(calls[0], ['dial', 'object', '/cannoi/msg/1.0.0']);
  assert.equal(calls[1][0], 'send'); assert.equal(calls[2][0], 'close');
  // inbound (libp2p 3.x: handler(stream, connection)); one valid message, one oversized one
  const got = []; lm.onMessage((m) => got.push(m.id));
  async function* one(b) { yield b; }
  await handler({ source: one(Buffer.from(JSON.stringify({ id: 'm1', from: 'x', to: 'me', type: 't' }))) }, { remotePeer: 'x' });
  await handler(one(Buffer.from(JSON.stringify({ id: 'm2', from: 'x', to: 'me', type: 't' }))), { remotePeer: 'x' });
  await handler(one(Buffer.alloc(5000, 97)), { remotePeer: 'x' });
  assert.deepEqual(got, ['m1', 'm2']);
});
