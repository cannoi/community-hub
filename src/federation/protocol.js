'use strict';
// Peer protocol v1: signed hello (endpoint proof) and signed requests (authentication, audience binding, replay protection).
const crypto = require('crypto');
const { HttpError, sha256hex, randomToken, TtlMap } = require('../util');
const { verify, accountIdFromPub, isAccountId } = require('../keystore');

const PROTOCOL = 1;
const REQ_DOMAIN = 'hub-req-v1';
const HELLO_DOMAIN = 'hub-hello-v1';
const MAX_SKEW_MS = 120000;

const helloMessage = (account, endpoint, nonce) => [account, endpoint, nonce].join('\0');

function signHello(ks, account, endpoint, nonce) { return ks.sign(account, HELLO_DOMAIN, helloMessage(account, endpoint, nonce)); }

/** Client side: verify a hello answer. Returns {account,pub,name} or throws Error with a short code. */
function verifyHello(resp, { nonce, expectEndpoint, pin, knownAccount, self }) {
  const fail = (c) => { const e = new Error(c); e.code = c; throw e; };
  if (!resp || resp.protocol !== PROTOCOL) fail('protocol_mismatch');
  if (!isAccountId(resp.account) || typeof resp.pub !== 'string') fail('bad_hello');
  if (accountIdFromPub(Buffer.from(resp.pub, 'base64url')) !== resp.account) fail('account_key_mismatch');
  if (resp.nonce !== nonce) fail('nonce_mismatch');
  if (!verify(resp.pub, HELLO_DOMAIN, helloMessage(resp.account, resp.endpoint, nonce), resp.sig)) fail('bad_hello_signature');
  let a, b; try { a = new URL(resp.endpoint).origin; b = new URL(expectEndpoint).origin; } catch { fail('bad_endpoint'); }
  if (a !== b) { const e = new Error('endpoint_mismatch'); e.code = 'endpoint_mismatch'; e.moved = resp.endpoint; e.account = resp.account; throw e; } // peer must prove it is the hub that lives at this URL
  if (resp.account === self) fail('self');
  if (pin && pin !== resp.account) fail('pin_mismatch');
  if (knownAccount && knownAccount !== resp.account) fail('identity_changed');
  return { account: resp.account, pub: resp.pub, name: typeof resp.name === 'string' ? resp.name.slice(0, 60) : null };
}

function signRequest(ks, account, { method, pathQuery, body, aud, endpoint }) {
  const time = String(Date.now()); const nonce = randomToken(16);
  const bodyHash = sha256hex(body || '');
  const msg = [method, pathQuery, time, nonce, aud, bodyHash].join('\0');
  const h = { 'X-Hub-Account': account, 'X-Hub-Pub': ks.publicKey(account), 'X-Hub-Time': time, 'X-Hub-Nonce': nonce, 'X-Hub-Aud': aud, 'X-Hub-Sig': ks.sign(account, REQ_DOMAIN, msg) };
  if (endpoint) h['X-Hub-Endpoint'] = endpoint;
  return h;
}

class RequestVerifier {
  constructor(selfAccount) { this.self = selfAccount; this.nonces = new TtlMap(20000); }
  /** @returns {{account:string,pub:string,endpoint?:string}} */
  verify(req, rawBody) {
    const h = req.headers;
    const account = h['x-hub-account']; const pub = h['x-hub-pub']; const time = Number(h['x-hub-time']); const nonce = h['x-hub-nonce']; const aud = h['x-hub-aud']; const sig = h['x-hub-sig'];
    const deny = (c) => { throw new HttpError(401, 'E_PEER_AUTH', 'Peer authentication failed', { reason: c }); };
    if (!account || !pub || !nonce || !aud || !sig || !Number.isFinite(time)) deny('missing_headers');
    if (!isAccountId(account) || String(nonce).length > 64) deny('malformed');
    if (accountIdFromPub(Buffer.from(String(pub), 'base64url')) !== account) deny('account_key_mismatch');
    if (aud !== this.self) deny('wrong_audience');
    if (Math.abs(Date.now() - time) > MAX_SKEW_MS) deny('stale');
    const msg = [req.method === 'HEAD' ? 'GET' : req.method, req.url, String(h['x-hub-time']), nonce, aud, sha256hex(rawBody || '')].join('\0');
    if (!verify(pub, REQ_DOMAIN, msg, sig)) deny('bad_signature');
    const key = account + ':' + nonce;
    if (this.nonces.has(key)) deny('replayed');
    this.nonces.set(key, MAX_SKEW_MS * 2 + 1000);
    return { account, pub, endpoint: h['x-hub-endpoint'] };
  }
}
module.exports = { PROTOCOL, signHello, verifyHello, signRequest, RequestVerifier };
