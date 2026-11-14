'use strict';
// Presence records: the ONLY thing that is shared network-wide. Tiny, signed by the account key, no content.
//   register  {v, account_id, pub, endpoint?, region?, name, searchable, ts, sig}   (≤ 2 KiB)
//   heartbeat {v, account_id, ts, sig}                                              (≤ 512 B)
//   withdraw  {v, account_id, ts, sig}
// No IP address, token, password, e-mail or content ever appears here. `endpoint` is an optional public URL hint.
const { canonicalize } = require('../util');
const { verify, accountIdFromPub, isAccountId } = require('../keystore');
const { validateEndpoint } = require('../federation/transport');

const REG_DOMAIN = 'hub-presence-v1';
const HB_DOMAIN = 'hub-presence-hb-v1';
const WD_DOMAIN = 'hub-presence-wd-v1';
const MAX_SKEW_MS = 5 * 60 * 1000;
const REG_KEYS = ['v', 'account_id', 'pub', 'endpoint', 'region', 'name', 'searchable', 'ts', 'sig'];
const SIMPLE_KEYS = ['v', 'account_id', 'ts', 'sig'];

class PresenceError extends Error {
  constructor(code, status = 400, msg) { super(msg || code); this.code = code; this.status = status; }
}
const bad = (code, status, msg) => { throw new PresenceError(code, status, msg); };

function unsignedOf(rec, keys) { const u = {}; for (const k of keys) if (k !== 'sig' && rec[k] !== undefined) u[k] = rec[k]; return u; }
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, '').trim().slice(0, 40);

function buildRecord(ks, { account, endpoint, region, name, searchable = true }, ts = Date.now()) {
  const rec = { v: 1, account_id: account, pub: ks.publicKey(account), name: cleanName(name) || account.slice(0, 10), searchable: !!searchable, ts };
  if (endpoint) rec.endpoint = endpoint;
  if (region && /^[A-Z]{2}$/.test(region)) rec.region = region;
  rec.sig = ks.sign(account, REG_DOMAIN, canonicalize(unsignedOf(rec, REG_KEYS)));
  return rec;
}
function buildSimple(ks, account, domain, ts = Date.now()) {
  const m = { v: 1, account_id: account, ts };
  m.sig = ks.sign(account, domain, canonicalize(unsignedOf(m, SIMPLE_KEYS)));
  return m;
}
const buildHeartbeat = (ks, account, ts) => buildSimple(ks, account, HB_DOMAIN, ts);
const buildWithdraw = (ks, account, ts) => buildSimple(ks, account, WD_DOMAIN, ts);

/** Strict validation + signature check. Returns the record unchanged. Throws PresenceError. */
function validateRecord(rec, { now = Date.now(), allowPrivate = false, checkTs = true } = {}) {
  if (!isObj(rec)) bad('E_PRESENCE_INVALID');
  for (const k of Object.keys(rec)) if (!REG_KEYS.includes(k)) bad('E_PRESENCE_INVALID', 400, 'unknown field ' + k);
  if (rec.v !== 1) bad('E_PRESENCE_INVALID', 400, 'unsupported version');
  if (!isAccountId(rec.account_id) || typeof rec.pub !== 'string' || rec.pub.length !== 43) bad('E_PRESENCE_INVALID');
  let derived; try { derived = accountIdFromPub(Buffer.from(rec.pub, 'base64url')); } catch { bad('E_PRESENCE_INVALID'); }
  if (derived !== rec.account_id) bad('E_PRESENCE_SIG', 401, 'account_id is not derived from pub');
  if (typeof rec.name !== 'string' || !rec.name.trim() || rec.name.length > 40 || /[\u0000-\u001f\u007f]/.test(rec.name)) bad('E_PRESENCE_INVALID', 400, 'name');
  if (typeof rec.searchable !== 'boolean') bad('E_PRESENCE_INVALID', 400, 'searchable');
  if (rec.region !== undefined && !/^[A-Z]{2}$/.test(rec.region)) bad('E_PRESENCE_INVALID', 400, 'region');
  if (!Number.isSafeInteger(rec.ts)) bad('E_PRESENCE_INVALID', 400, 'ts');
  if (checkTs && Math.abs(now - rec.ts) > MAX_SKEW_MS) bad('E_PRESENCE_SKEW', 400, 'clock skew too large');
  if (rec.endpoint !== undefined) {
    if (typeof rec.endpoint !== 'string' || rec.endpoint.length > 200) bad('E_PRESENCE_ENDPOINT');
    let origin; try { origin = validateEndpoint(rec.endpoint, { allowPrivate }); } catch { bad('E_PRESENCE_ENDPOINT', 400, 'endpoint must be a public http(s) origin'); }
    if (origin !== rec.endpoint) bad('E_PRESENCE_ENDPOINT', 400, 'endpoint must be a bare origin');
  }
  if (typeof rec.sig !== 'string' || rec.sig.length !== 86 || !verify(rec.pub, REG_DOMAIN, canonicalize(unsignedOf(rec, REG_KEYS)), rec.sig)) bad('E_PRESENCE_SIG', 401, 'bad signature');
  return rec;
}
function validateSimple(msg, pub, domain, { now = Date.now(), checkTs = true } = {}) {
  if (!isObj(msg)) bad('E_PRESENCE_INVALID');
  for (const k of Object.keys(msg)) if (!SIMPLE_KEYS.includes(k)) bad('E_PRESENCE_INVALID');
  if (msg.v !== 1 || !isAccountId(msg.account_id) || !Number.isSafeInteger(msg.ts)) bad('E_PRESENCE_INVALID');
  if (checkTs && Math.abs(now - msg.ts) > MAX_SKEW_MS) bad('E_PRESENCE_SKEW', 400, 'clock skew too large');
  if (typeof msg.sig !== 'string' || msg.sig.length !== 86 || !verify(pub, domain, canonicalize(unsignedOf(msg, SIMPLE_KEYS)), msg.sig)) bad('E_PRESENCE_SIG', 401, 'bad signature');
  return msg;
}

module.exports = { buildRecord, buildHeartbeat, buildWithdraw, validateRecord, validateSimple, PresenceError, HB_DOMAIN, WD_DOMAIN, REG_DOMAIN, MAX_SKEW_MS, cleanName };
