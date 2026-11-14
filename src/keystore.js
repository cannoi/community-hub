'use strict';
// Cryptographic identity: Ed25519 keys (node:crypto / OpenSSL). Private keys never leave this module
// except through exportKey() which re-encrypts them under a caller-supplied export passphrase.
//
// Account ID format "hub1": 'hub1_' + base32lower(SHA-256(raw 32-byte Ed25519 public key))  (52 chars).
// The ID is bound to the key, so it does not change when the network endpoint (IP/URL) changes.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { base32, b64u, fromB64u, sha256 } = require('./util');

const ACCOUNT_RE = /^hub1_[a-z2-7]{52}$/;
const SIG_DOMAIN = Buffer.from('hub-sig-v1\0');

function rawPubFromKeyObject(pub) { return fromB64u(pub.export({ format: 'jwk' }).x); }
function accountIdFromPub(rawPub) { return 'hub1_' + base32(sha256(rawPub)); }
function publicKeyObject(pubB64u) {
  const raw = fromB64u(pubB64u);
  if (raw.length !== 32) throw new Error('bad public key length');
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(raw) }, format: 'jwk' });
}
/** Verify `sig` over `msg` with domain separation. Returns boolean, never throws. */
function verify(pubB64u, domain, msg, sigB64u) {
  try {
    const sig = fromB64u(sigB64u);
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.concat([Buffer.from(domain + '\0'), Buffer.from(msg)]), publicKeyObject(pubB64u), sig);
  } catch { return false; }
}
const isAccountId = (s) => typeof s === 'string' && ACCOUNT_RE.test(s);

function aesEncrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv: b64u(iv), tag: b64u(c.getAuthTag()), ct: b64u(ct) };
}
function aesDecrypt(key, enc, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, fromB64u(enc.iv));
  d.setAAD(Buffer.from(aad)); d.setAuthTag(fromB64u(enc.tag));
  return Buffer.concat([d.update(fromB64u(enc.ct)), d.final()]);
}
const scrypt = (pass, salt, n = 16384) => crypto.scryptSync(pass, salt, 32, { N: n, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

class Keystore {
  /**
   * @param {string} dir directory for keystore.json (+ master.key when no passphrase is configured)
   * @param {string} passphrase optional HUB_KEY_PASSPHRASE; if set the key-encryption key is derived from it
   */
  constructor(dir, passphrase = '') {
    this.dir = dir; this.file = path.join(dir, 'keystore.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, mode: passphrase ? 'passphrase' : 'file', salt: b64u(crypto.randomBytes(16)), keys: {} };
    const mode = passphrase ? 'passphrase' : 'file';
    if (this.data.mode !== mode) throw new Error(`Keystore was created in "${this.data.mode}" mode; HUB_KEY_PASSPHRASE ${passphrase ? 'is set' : 'is not set'} now. Restore the previous setting.`);
    this.kek = passphrase ? scrypt(passphrase, fromB64u(this.data.salt)) : this._masterKey();
    this.cache = new Map();
    // fail fast on a wrong passphrase / corrupted master key
    const first = Object.keys(this.data.keys)[0];
    if (first) { try { this._priv(first); } catch { throw new Error('Cannot decrypt keystore: wrong HUB_KEY_PASSPHRASE or corrupted master key'); } }
    this._save();
  }
  _masterKey() {
    const f = path.join(this.dir, 'master.key');
    if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64url');
    const k = crypto.randomBytes(32);
    fs.writeFileSync(f, b64u(k), { mode: 0o600 });
    return k;
  }
  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  _priv(accountId) {
    let k = this.cache.get(accountId);
    if (k) return k;
    const e = this.data.keys[accountId];
    if (!e) throw new Error('unknown local key');
    k = crypto.createPrivateKey({ key: aesDecrypt(this.kek, e.enc, accountId), format: 'der', type: 'pkcs8' });
    this.cache.set(accountId, k);
    return k;
  }
  has(accountId) { return !!this.data.keys[accountId]; }
  list() { return Object.keys(this.data.keys); }
  publicKey(accountId) { return this.data.keys[accountId]?.pub; }
  _store(privKeyObj) {
    const pubRaw = rawPubFromKeyObject(crypto.createPublicKey(privKeyObj));
    const accountId = accountIdFromPub(pubRaw);
    if (this.data.keys[accountId]) throw new Error('key already present');
    const der = privKeyObj.export({ format: 'der', type: 'pkcs8' });
    this.data.keys[accountId] = { pub: b64u(pubRaw), created_at: Date.now(), enc: aesEncrypt(this.kek, der, accountId) };
    this._save();
    return { accountId, pub: b64u(pubRaw) };
  }
  generate() { return this._store(crypto.generateKeyPairSync('ed25519').privateKey); }
  sign(accountId, domain, msg) {
    return b64u(crypto.sign(null, Buffer.concat([Buffer.from(domain + '\0'), Buffer.from(msg)]), this._priv(accountId)));
  }
  /** Password-protected export of one private key (caller must have authenticated the owner first). */
  exportKey(accountId, exportPassphrase) {
    if (!exportPassphrase || exportPassphrase.length < 10) throw new Error('export passphrase must be at least 10 characters');
    const der = this._priv(accountId).export({ format: 'der', type: 'pkcs8' });
    const salt = crypto.randomBytes(16);
    const key = scrypt(exportPassphrase, salt);
    return { format: 'community-hub-key-export', version: 1, account_id: accountId, pub: this.data.keys[accountId].pub, salt: b64u(salt), kdf: 'scrypt-N16384-r8-p1', enc: aesEncrypt(key, der, accountId) };
  }
  importKey(blob, exportPassphrase) {
    if (!blob || blob.format !== 'community-hub-key-export' || blob.version !== 1 || !isAccountId(blob.account_id)) throw new Error('unsupported key export');
    let der;
    try { der = aesDecrypt(scrypt(exportPassphrase, fromB64u(blob.salt)), blob.enc, blob.account_id); } catch { throw new Error('wrong export passphrase or corrupted file'); }
    const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    const res = this._store(priv);
    if (res.accountId !== blob.account_id) { delete this.data.keys[res.accountId]; this._save(); throw new Error('key export does not match its account id'); }
    return res;
  }
}

module.exports = { Keystore, accountIdFromPub, isAccountId, verify, publicKeyObject, ACCOUNT_RE };
