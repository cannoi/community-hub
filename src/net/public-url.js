'use strict';
/**
 * Single source for this Hub's public URL (WP1.1).
 * Order: owner override → env HUB_PUBLIC_URL/PUBLIC_URL → empty.
 * Request Host is used only for hello signing (not stored globally).
 */
function normalize(url) {
  const s = String(url || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (u.username || u.password) return '';
    return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
  } catch {
    return '';
  }
}

function fromEnv() {
  return normalize(process.env.HUB_PUBLIC_URL || process.env.PUBLIC_URL || process.env.SOLOHOST_PUBLIC_URL || process.env.APP_PUBLIC_URL || '');
}

function fromOwner(db) {
  if (!db) return '';
  try {
    const row = db.get("SELECT value FROM meta WHERE key='public_url_override'");
    return normalize(row && row.value);
  } catch {
    return '';
  }
}

function fromRequest(req) {
  if (!req || !req.headers) return '';
  const xfHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = xfHost || String(req.headers.host || '').split(',')[0].trim();
  if (!host) return '';
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xfProto || 'http';
  return normalize(proto + '://' + host);
}

/**
 * @param {{ db?: object, req?: object, cfg?: object }} opts
 * @returns {{ url: string, source: 'override'|'env'|'cfg'|'request'|'none' }}
 */
function resolvePublicUrl(opts = {}) {
  const ov = fromOwner(opts.db);
  if (ov) return { url: ov, source: 'override' };
  const env = fromEnv();
  if (env) return { url: env, source: 'env' };
  if (opts.cfg && opts.cfg.publicUrl) {
    const c = normalize(opts.cfg.publicUrl);
    if (c) return { url: c, source: 'cfg' };
  }
  if (opts.req) {
    const r = fromRequest(opts.req);
    if (r) return { url: r, source: 'request' };
  }
  return { url: '', source: 'none' };
}

module.exports = { resolvePublicUrl, normalize, fromEnv, fromOwner, fromRequest };
