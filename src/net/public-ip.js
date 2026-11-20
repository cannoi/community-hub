'use strict';
/**
 * Auto-detect this machine's public IPv4 for P2P multiaddr advertising.
 * Zero-config: no operator input. Order: env → cache file → HTTPS probes → null.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const PROBES = [
  { url: 'https://api.ipify.org', parse: (b) => String(b).trim() },
  { url: 'https://ifconfig.me/ip', parse: (b) => String(b).trim() },
  { url: 'https://icanhazip.com', parse: (b) => String(b).trim() },
  { url: 'http://checkip.amazonaws.com', parse: (b) => String(b).trim() },
];

function isPublicV4(ip) {
  if (!IPV4_RE.test(ip)) return false;
  const p = ip.split('.').map(Number);
  if (p.some((n) => n > 255)) return false;
  if (p[0] === 10) return false;
  if (p[0] === 127) return false;
  if (p[0] === 0) return false;
  if (p[0] === 169 && p[1] === 254) return false;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
  if (p[0] === 192 && p[1] === 168) return false;
  if (p[0] >= 224) return false;
  return true;
}

function fetchText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'community-hub-public-ip/1' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchText(res.headers.location, timeoutMs).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function cachePath(dataDir) {
  return path.join(dataDir || 'data', 'public-ip.cache.json');
}

function readCache(dataDir, maxAgeMs) {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(dataDir), 'utf8'));
    if (!j || !j.ip || !isPublicV4(j.ip)) return null;
    if (maxAgeMs && j.at && Date.now() - j.at > maxAgeMs) return { ip: j.ip, stale: true };
    return { ip: j.ip, stale: false };
  } catch { return null; }
}

function writeCache(dataDir, ip) {
  try {
    fs.mkdirSync(path.dirname(cachePath(dataDir)), { recursive: true });
    fs.writeFileSync(cachePath(dataDir), JSON.stringify({ ip, at: Date.now() }), 'utf8');
  } catch { /* ignore */ }
}

/**
 * Resolve public IPv4.
 * @returns {Promise<string|null>}
 */
async function detectPublicIp(opts = {}) {
  const envIp = String(opts.envIp || process.env.PUBLIC_IP || process.env.HUB_PUBLIC_IP || '').trim();
  if (isPublicV4(envIp)) return envIp;

  const dataDir = opts.dataDir || process.env.DATA_DIR || 'data';
  const timeoutMs = opts.timeoutMs || 4000;
  const cached = readCache(dataDir, opts.maxAgeMs || 7 * 86400000);
  if (cached && !cached.stale) return cached.ip;

  for (const probe of PROBES) {
    try {
      const body = await fetchText(probe.url, timeoutMs);
      const ip = probe.parse(body).replace(/[^\d.]/g, '');
      if (isPublicV4(ip)) {
        writeCache(dataDir, ip);
        return ip;
      }
    } catch { /* try next */ }
  }
  if (cached && cached.ip) return cached.ip; // stale fallback offline
  return null;
}

/** Build http(s) public root for this Hub when operator left URL empty. */
function buildPublicUrl(ip, port, secure) {
  if (!ip || !port) return '';
  return (secure ? 'https://' : 'http://') + ip + ':' + Number(port);
}

module.exports = { detectPublicIp, buildPublicUrl, isPublicV4, readCache, writeCache };
