'use strict';
/**
 * Compact invite codes: chub1.<base64url(JSON)>
 * Payload: { v:1, a: accountId?, e: [urls], n: name?, t: oneTimeToken? }
 */
const crypto = require('crypto');
const { validateEndpoint } = require('./transport');
const { isAccountId } = require('../keystore');

function b64uJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function parseB64uJson(s) {
  return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
}

function createInvite({ account, endpoints, name, token } = {}) {
  const e = (Array.isArray(endpoints) ? endpoints : [endpoints]).filter(Boolean).map(String).slice(0, 3);
  if (!e.length) throw Object.assign(new Error('endpoints required'), { code: 'E_INVALID' });
  const payload = { v: 1, e };
  if (account && isAccountId(account)) payload.a = account;
  if (name) payload.n = String(name).slice(0, 80);
  if (token) payload.t = String(token).slice(0, 64);
  return 'chub1.' + b64uJson(payload);
}

/**
 * @returns {{ account?: string, endpoints: string[], name?: string, token?: string, raw: string }}
 */
function parseInvite(raw, { allowPrivate = false } = {}) {
  const s = String(raw || '').trim();
  if (!s.toLowerCase().startsWith('chub1.')) {
    throw Object.assign(new Error('not an invite'), { code: 'E_INVITE_INVALID' });
  }
  let payload;
  try {
    payload = parseB64uJson(s.slice(6));
  } catch {
    throw Object.assign(new Error('bad invite encoding'), { code: 'E_INVITE_INVALID' });
  }
  if (!payload || payload.v !== 1 || !Array.isArray(payload.e) || !payload.e.length) {
    throw Object.assign(new Error('bad invite payload'), { code: 'E_INVITE_INVALID' });
  }
  const endpoints = [];
  for (const u of payload.e.slice(0, 3)) {
    try {
      endpoints.push(validateEndpoint(u, { allowPrivate }));
    } catch (err) {
      throw Object.assign(new Error(err.code || 'bad_url'), { code: 'E_INVITE_INVALID' });
    }
  }
  if (payload.a && !isAccountId(payload.a)) {
    throw Object.assign(new Error('bad account'), { code: 'E_INVITE_INVALID' });
  }
  return {
    account: payload.a || null,
    endpoints,
    name: payload.n ? String(payload.n).slice(0, 80) : null,
    token: payload.t ? String(payload.t).slice(0, 64) : null,
    raw: s,
  };
}

/** Detect invite or hub1_…@url or plain URL → normalized peer add target string. */
function normalizePeerInput(raw, opts = {}) {
  const s = String(raw || '').trim();
  if (!s) throw Object.assign(new Error('empty'), { code: 'E_PEER_BAD_URL' });
  if (/^chub1\./i.test(s)) {
    const inv = parseInvite(s, opts);
    const ep = inv.endpoints[0];
    return inv.account ? `${inv.account}@${ep}` : ep;
  }
  return s;
}

function issueInviteToken(secret) {
  return crypto.createHmac('sha256', String(secret || 'hub')).update('invite:' + Date.now() + ':' + crypto.randomBytes(8).toString('hex')).digest('base64url').slice(0, 24);
}

module.exports = { createInvite, parseInvite, normalizePeerInput, issueInviteToken };
