'use strict';
/**
 * Phase 5 completion — signing primitives for the replicated public index.
 *
 * Every signed object uses a domain-separated canonical payload so a signature made for one purpose
 * (document, tombstone, election vote) can never be replayed as another.
 *
 * A "signer" is { peerId, sign(payload)->Promise<base64>, verify(payload, sigB64, peerId)->Promise<boolean> }.
 *  - createLibp2pSigner(): binds to the Hub's existing libp2p identity (production). It needs the libp2p modules, which are
 *    NOT installable in the offline build sandbox, so it is exercised only through injected fakes in unit tests.
 *  - createEd25519Signer(): self-contained Node-crypto identity (peerId = base58(raw public key)). Used by tests and the
 *    multi-process simulation. It is not a replacement for the libp2p identity.
 */
const crypto = require('crypto');

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const sortedUnique = (a) => [...new Set((Array.isArray(a) ? a : []).map(String))].sort();

function docPayload(d) {
  return 'cannoi-index-doc/1|' + JSON.stringify([
    String(d.origin_peer), String(d.content_id), String(d.title || '').slice(0, 300), String(d.text != null ? d.text : (d.body || '')).slice(0, 12000),
    String(d.language || 'und').slice(0, 12), String(d.region || 'ZZ').slice(0, 2).toUpperCase(),
    (Array.isArray(d.topics) ? d.topics : []).map((x) => String(x).slice(0, 40)).slice(0, 12),
    String(d.content_hash || ''), Number(d.updated_at) || 0,
  ]);
}
const tombPayload = (origin, id, version) => 'cannoi-index-del/1|' + JSON.stringify([String(origin), String(id), Number(version) || 0]);
function votePayload({ shard, epoch, candidate, members, old_members, voter }) {
  return 'cannoi-index-vote/1|' + JSON.stringify([Number(shard), Number(epoch), String(candidate), sha256(sortedUnique(members).join(',')), sha256(sortedUnique(old_members).join(',')), String(voter)]);
}

const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(buf) {
  let n = BigInt('0x' + (buf.toString('hex') || '0')); let s = '';
  while (n > 0n) { s = ALPHA[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
function b58decode(str) {
  let n = 0n;
  for (const ch of String(str)) { const i = ALPHA.indexOf(ch); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let zeros = 0; for (const ch of String(str)) { if (ch === '1') zeros++; else break; }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
function createEd25519Signer(existing) {
  const kp = existing || crypto.generateKeyPairSync('ed25519');
  const raw = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const peerId = b58encode(Buffer.from(raw));
  return {
    peerId,
    async sign(payload) { return crypto.sign(null, Buffer.from(String(payload)), kp.privateKey).toString('base64'); },
    async verify(payload, sigB64, id) {
      try {
        const pub = b58decode(id); if (pub.length !== 32) return false;
        const key = crypto.createPublicKey({ key: Buffer.concat([SPKI, pub]), format: 'der', type: 'spki' });
        return crypto.verify(null, Buffer.from(String(payload)), key, Buffer.from(String(sigB64), 'base64'));
      } catch { return false; }
    },
  };
}

/** Production binding to the existing libp2p identity. Fails closed: any import/verify error => false. */
function createLibp2pSigner({ privateKey, peerId, importer }) {
  const load = importer || ((n) => import(n));
  return {
    peerId: String(peerId),
    async sign(payload) { return Buffer.from(await privateKey.sign(Buffer.from(String(payload)))).toString('base64'); },
    async verify(payload, sigB64, id) {
      try {
        const mod = await load('@libp2p/peer-id');
        const pid = typeof mod.peerIdFromString === 'function' ? mod.peerIdFromString(String(id)) : null;
        const pub = pid && pid.publicKey; // Ed25519 / secp256k1 peer ids embed the public key
        if (!pub || typeof pub.verify !== 'function') return false;
        return (await pub.verify(Buffer.from(String(payload)), Buffer.from(String(sigB64), 'base64'))) === true;
      } catch { return false; }
    },
  };
}

module.exports = { sha256, sortedUnique, docPayload, tombPayload, votePayload, b58encode, b58decode, createEd25519Signer, createLibp2pSigner };
