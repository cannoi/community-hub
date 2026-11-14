'use strict';
/**
 * Resolve this Hub's public access URL.
 * - No global advertisedPort mutated by untrusted headers (SEC-02).
 * - No outbound third-party IP lookup by default.
 * - Prefer owner override → env PUBLIC_URL/HUB_PUBLIC_URL → PUBLIC_IP+HOST_PORT → empty.
 */
const os = require('os');

const PRIVATE_RE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.)/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function getLanIps(hostPort) {
  const out = [];
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs || {})) {
      for (const a of ifs[name] || []) {
        if (a.family !== 'IPv4' && a.family !== 4) continue;
        if (a.internal) continue;
        if (hostPort) out.push('http://' + a.address + ':' + hostPort);
        else out.push('http://' + a.address);
      }
    }
  } catch (_) { /* ignore */ }
  return out;
}

function envHostPort() {
  const envP = process.env.HOST_PORT || process.env.SOLOHOST_HOST_PORT || process.env.PUBLIC_PORT || '';
  if (/^\d+$/.test(envP)) {
    const n = Number(envP);
    if (n > 0 && n < 65536) return String(n);
  }
  return '';
}

/**
 * @param {object} req
 * @param {object} [opts]
 * @param {string} [opts.ownerOverride]
 * @param {boolean} [opts.includeLan] - owner only
 * @param {boolean} [opts.trustRequestHost]
 */
async function resolveAccessInfo(req, opts = {}) {
  const headers = (req && req.headers) || {};
  const hostPort = envHostPort();

  const override = String(opts.ownerOverride || process.env.SOLOHOST_PUBLIC_URL || process.env.PUBLIC_URL || process.env.APP_PUBLIC_URL || process.env.HUB_PUBLIC_URL || '').replace(/\/+$/, '');
  if (override) {
    let publicIp = '';
    try {
      const u = new URL(override);
      if (IPV4_RE.test(u.hostname)) publicIp = u.hostname;
    } catch (_) {}
    return {
      ok: true,
      publicUrl: override,
      publicIp,
      hostPort: hostPort ? Number(hostPort) : null,
      source: opts.ownerOverride ? 'override' : 'env',
      lanUrls: opts.includeLan ? getLanIps(hostPort) : undefined,
    };
  }

  const hostHeader = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim();
  const isLoopback = !hostHeader || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(hostHeader);
  const proto = String(headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';

  if (!isLoopback && hostHeader && opts.trustRequestHost) {
    return {
      ok: true,
      publicUrl: proto + '://' + hostHeader,
      publicIp: (hostHeader.match(/^(\d{1,3}(?:\.\d{1,3}){3})/) || [])[1] || '',
      hostPort: hostPort ? Number(hostPort) : null,
      source: 'host',
      lanUrls: opts.includeLan ? getLanIps(hostPort) : undefined,
    };
  }

  const envIp = process.env.PUBLIC_IP || process.env.SOLOHOST_PUBLIC_IP || '';
  if (envIp && IPV4_RE.test(envIp) && !PRIVATE_RE.test(envIp) && hostPort) {
    return {
      ok: true,
      publicUrl: 'http://' + envIp + ':' + hostPort,
      publicIp: envIp,
      hostPort: Number(hostPort),
      source: 'env-ip',
      lanUrls: opts.includeLan ? getLanIps(hostPort) : undefined,
    };
  }

  return {
    ok: false,
    publicUrl: '',
    publicIp: envIp && IPV4_RE.test(envIp) ? envIp : '',
    hostPort: hostPort ? Number(hostPort) : null,
    source: 'none',
    lanUrls: opts.includeLan ? getLanIps(hostPort) : undefined,
  };
}

function rememberPublicPort() { return envHostPort(); }
async function resolvePublicIp() {
  return process.env.PUBLIC_IP || process.env.SOLOHOST_PUBLIC_IP || '';
}

module.exports = {
  rememberPublicPort,
  resolvePublicIp,
  resolveAccessInfo,
  getLanIps,
};
