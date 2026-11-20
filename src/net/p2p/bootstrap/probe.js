'use strict';
/**
 * Probe-back verification for published multiaddrs.
 * Fetches GET <base>/p2p/bootstrap and checks peer_id matches the claimed record.
 * Blocks private IPs (SSRF). Short timeout. Result cached briefly.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const net = require('net');

const cache = new Map(); // key -> { at, ok, reason, peer_id }
const CACHE_MS = 60000;

function isPrivateIp(ip) {
  if (!net.isIP(ip)) return true;
  const p = ip.split('.').map(Number);
  if (ip === '127.0.0.1' || ip === '0.0.0.0') return true;
  if (p[0] === 10 || p[0] === 127 || p[0] >= 224) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}

function multiaddrToHttpBase(ma) {
  // /ip4/1.2.3.4/tcp/8182/ws/p2p/ID  or /dns4/host/tcp/8182/ws/...
  const parts = String(ma).split('/').filter(Boolean);
  let host = null, port = null, tls = false;
  for (let i = 0; i < parts.length; i++) {
    if ((parts[i] === 'ip4' || parts[i] === 'ip6' || parts[i] === 'dns4' || parts[i] === 'dns6' || parts[i] === 'dns') && parts[i + 1]) {
      host = parts[i + 1];
    }
    if (parts[i] === 'tcp' && parts[i + 1]) port = Number(parts[i + 1]);
    if (parts[i] === 'tls' || parts[i] === 'wss') tls = true;
  }
  if (!host || !port) return null;
  if (net.isIP(host) === 4 && isPrivateIp(host)) return null;
  const proto = tls ? 'https' : 'http';
  return `${proto}://${host}:${port}`;
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('bad scheme'));
    if (net.isIP(u.hostname) && isPrivateIp(u.hostname)) return reject(new Error('private'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, { timeout: timeoutMs, headers: { Accept: 'application/json', 'User-Agent': 'cannoi-probe/1' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 65536);
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

/**
 * @param {object} record - { peer_id, multiaddrs }
 * @param {object} opts - { timeoutMs, sourceIp }
 * @returns {Promise<{ verified: boolean, reason?: string, observed_peer_id?: string }>}
 */
async function probePeerRecord(record, opts = {}) {
  const timeoutMs = opts.timeoutMs || 4000;
  const peerId = record && record.peer_id;
  const mas = (record && record.multiaddrs) || [];
  if (!peerId || !mas.length) return { verified: false, reason: 'invalid' };

  for (const ma of mas.slice(0, 3)) {
    const base = multiaddrToHttpBase(ma);
    if (!base) continue;
    const key = base + '|' + peerId;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      return { verified: hit.ok, reason: hit.reason, observed_peer_id: hit.peer_id };
    }
    try {
      // optional: require source IP matches multiaddr host
      if (opts.sourceIp) {
        const host = new URL(base).hostname;
        if (net.isIP(host) === 4 && host !== opts.sourceIp) {
          cache.set(key, { at: Date.now(), ok: false, reason: 'ip_mismatch', peer_id: null });
          return { verified: false, reason: 'ip_mismatch' };
        }
      }
      const { status, json } = await fetchJson(base + '/p2p/bootstrap', timeoutMs);
      if (status !== 200 || !json) {
        cache.set(key, { at: Date.now(), ok: false, reason: 'unreachable', peer_id: null });
        return { verified: false, reason: 'unreachable' };
      }
      const observed = json.peer_id || null;
      if (observed && observed === peerId) {
        cache.set(key, { at: Date.now(), ok: true, reason: null, peer_id: observed });
        return { verified: true, observed_peer_id: observed };
      }
      cache.set(key, { at: Date.now(), ok: false, reason: 'wrong_peer', peer_id: observed });
      return { verified: false, reason: 'wrong_peer', observed_peer_id: observed };
    } catch {
      cache.set(key, { at: Date.now(), ok: false, reason: 'unreachable', peer_id: null });
      return { verified: false, reason: 'unreachable' };
    }
  }
  return { verified: false, reason: 'unreachable' };
}

module.exports = { probePeerRecord, multiaddrToHttpBase, isPrivateIp };
