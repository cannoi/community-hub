'use strict';
/**
 * libp2p 3.x compatibility helpers.
 *
 * libp2p 3 no longer accepts multiaddr STRINGS in node.dial(): it needs a Multiaddr object (or a PeerId). Handing it a string made
 * it call `multiaddrs[0].getComponents()` on a string and fail with "multiaddrs[0].getComponents is not a function", so every
 * Hub-to-Hub dial failed and the status page showed "0 links / offline". The same release replaced stream.sink/source by
 * stream.send()/async-iteration and passes (stream, connection) to protocol handlers. Everything here accepts BOTH shapes so
 * the Hub works with libp2p 2.x and 3.x. Modules are imported lazily and can be injected, so this is unit-testable without libp2p.
 */
const defaultImporter = (name) => import(name);
const cache = new Map();

function load(name, importer = defaultImporter) {
  const key = name;
  if (importer === defaultImporter && cache.has(key)) return cache.get(key);
  const p = Promise.resolve().then(() => importer(name)).catch((e) => {
    cache.delete(key);
    const err = new Error(`${name} is not installed (${(e && e.message) || e})`);
    err.code = 'E_P2P_MODULES';
    throw err;
  });
  if (importer === defaultImporter) cache.set(key, p);
  return p;
}

const isObj = (x) => x !== null && typeof x === 'object';

/** string | Multiaddr | (string|Multiaddr)[]  ->  Multiaddr | Multiaddr[]   (objects pass through untouched) */
async function toMultiaddr(input, importer) {
  if (Array.isArray(input)) return Promise.all(input.map((x) => toMultiaddr(x, importer)));
  if (isObj(input)) return input;
  const s = String(input || '').trim();
  if (!s.startsWith('/')) { const e = new Error('invalid multiaddr'); e.code = 'E_P2P_BAD_ADDR'; throw e; }
  const mod = await load('@multiformats/multiaddr', importer);
  const fn = mod.multiaddr || (mod.default && mod.default.multiaddr);
  if (typeof fn !== 'function') { const e = new Error('multiaddr() not exported by @multiformats/multiaddr'); e.code = 'E_P2P_MODULES'; throw e; }
  return fn(s);
}

/** string | PeerId -> PeerId */
async function toPeerId(input, importer) {
  if (isObj(input)) return input;
  const mod = await load('@libp2p/peer-id', importer);
  if (typeof mod.peerIdFromString !== 'function') { const e = new Error('peerIdFromString not available'); e.code = 'E_P2P_MODULES'; throw e; }
  return mod.peerIdFromString(String(input));
}

/** Protocol handlers: libp2p 2.x calls fn({stream, connection}); libp2p 3.x calls fn(stream, connection). */
function handlerArgs(a, b) {
  if (a && a.stream && (a.connection || b === undefined)) return { stream: a.stream, connection: a.connection || null };
  return { stream: a, connection: b || null };
}

/** Read a whole stream (v2: stream.source, v3: the stream itself is async iterable) with a hard size limit. */
async function readStream(stream, maxBytes = 65536) {
  const it = stream && stream.source ? stream.source : stream;
  if (!it || typeof it[Symbol.asyncIterator] !== 'function') { const e = new Error('stream is not readable'); e.code = 'E_P2P_STREAM'; throw e; }
  const chunks = []; let total = 0;
  for await (const c of it) {
    const b = Buffer.from(c && c.subarray ? c.subarray() : c);
    total += b.length;
    if (total > maxBytes) { const e = new Error('message too large'); e.code = 'E_P2P_TOO_LARGE'; throw e; }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/** Write once (v2: stream.sink([data]); v3: stream.send(data), waiting for drain when the buffer is full). */
async function writeStream(stream, data) {
  if (stream && typeof stream.send === 'function') {
    const ok = stream.send(data);
    if (ok === false && typeof stream.onDrain === 'function') await stream.onDrain();
    return;
  }
  if (stream && typeof stream.sink === 'function') { await stream.sink([data]); return; }
  const e = new Error('stream is not writable'); e.code = 'E_P2P_STREAM'; throw e;
}

module.exports = { toMultiaddr, toPeerId, handlerArgs, readStream, writeStream, defaultImporter };
