'use strict';
// Pure, dependency-free address policy for the P2P layer. Used BEFORE anything reaches libp2p, so malformed or
// dangerous multiaddrs can never crash the Hub, open an uncontrolled port or turn the Hub into an SSRF probe.
const net = require('net');
const { isPublicIp } = require('../../federation/transport');

const DEFAULT_LISTEN = '/ip4/127.0.0.1/tcp/0/ws'; // loopback backend; external reachability goes through the HTTP-port gateway
const PEER_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{30,80}$/;                 // base58btc (12D3Koo…, Qm…)
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

class P2PAddrError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }
const bad = (code, msg) => { throw new P2PAddrError(code, msg); };

/** Strict parser for /(ip4|ip6|dns|dns4|dns6)/<host>/tcp/<port>/(ws|wss|tls/ws)[/p2p/<peerId>]. Throws P2PAddrError. */
function parseMultiaddr(s, { allowPortZero = false } = {}) {
  if (typeof s !== 'string' || s.length < 8 || s.length > 300) bad('E_P2P_BAD_ADDR', 'multiaddr must be a string of 8-300 characters');
  if (!/^\/[\x21-\x7e]+$/.test(s) || s.endsWith('/') || s.includes('//')) bad('E_P2P_BAD_ADDR', 'malformed multiaddr');
  const p = s.split('/').slice(1); let i = 0;
  const hostType = p[i++]; const host = p[i++];
  if (!['ip4', 'ip6', 'dns', 'dns4', 'dns6'].includes(hostType) || !host) bad('E_P2P_BAD_ADDR', 'unsupported host component');
  if (hostType === 'ip4' && !net.isIPv4(host)) bad('E_P2P_BAD_ADDR', 'invalid ip4');
  if (hostType === 'ip6' && !net.isIPv6(host)) bad('E_P2P_BAD_ADDR', 'invalid ip6');
  if (hostType.startsWith('dns') && !HOST_RE.test(host)) bad('E_P2P_BAD_ADDR', 'invalid hostname');
  if (p[i++] !== 'tcp') bad('E_P2P_BAD_ADDR', 'tcp component required');
  const ps = p[i++];
  if (!/^(0|[1-9][0-9]{0,4})$/.test(ps || '')) bad('E_P2P_BAD_ADDR', 'invalid port');
  const port = Number(ps);
  if (port > 65535 || (port === 0 && !allowPortZero)) bad('E_P2P_BAD_ADDR', 'port out of range');
  let secure = false;
  if (p[i] === 'tls' && p[i + 1] === 'ws') { secure = true; i += 2; }
  else if (p[i] === 'wss') { secure = true; i++; }
  else if (p[i] === 'ws') { i++; }
  else bad('E_P2P_BAD_ADDR', 'ws or wss transport required');
  let peerId = null;
  if (i < p.length) { if (p[i] !== 'p2p' || !PEER_ID_RE.test(p[i + 1] || '') || i + 2 !== p.length) bad('E_P2P_BAD_ADDR', 'only an optional trailing /p2p/<id> is allowed'); peerId = p[i + 1]; }
  return { hostType, host, port, secure, peerId };
}

const isLoopbackHost = (h) => /^127\./.test(h) || h === '::1';

/** May the Hub dial this address? Private/loopback targets are refused unless allowPrivate (LAN / tests). */
function checkDial(addr, { allowPrivate = false } = {}) {
  const a = typeof addr === 'string' ? parseMultiaddr(addr) : addr;
  if (!allowPrivate) {
    if (a.hostType === 'ip4' || a.hostType === 'ip6') { if (!isPublicIp(a.host)) bad('E_P2P_PRIVATE_ADDR', 'private, loopback or link-local addresses are not dialable'); }
    else if (/(^|\.)localhost$/i.test(a.host) || /\.(local|internal|lan|home|corp)$/i.test(a.host)) bad('E_P2P_PRIVATE_ADDR', 'local hostnames are not dialable');
  }
  return a;
}

/**
 * Listen policy. The default is ONE loopback ephemeral port: it is only reachable through the Hub's own HTTP port
 * (WsGateway), never as a separate public port. Non-loopback listeners need allowPublic; the HTTP port is refused.
 * @returns {{listen:string[], rejected:{addr:string, code:string}[]}}
 */
function normalizeListen(list, { httpPort = 0, allowPublic = false } = {}) {
  const out = []; const rejected = [];
  for (const raw of Array.isArray(list) ? list : []) {
    try {
      const a = parseMultiaddr(raw, { allowPortZero: true });
      if (a.hostType.startsWith('dns')) bad('E_P2P_BAD_ADDR', 'listen addresses must be IPs');
      if (a.secure) bad('E_P2P_BAD_ADDR', 'TLS terminates at the reverse proxy; listen on plain /ws');
      if (a.peerId) bad('E_P2P_BAD_ADDR', 'listen addresses must not contain /p2p');
      if (!isLoopbackHost(a.host) && !allowPublic) bad('E_P2P_PUBLIC_LISTEN', 'non-loopback listeners need p2p.allowPublicListen=true');
      if (httpPort && a.port === httpPort) bad('E_P2P_PORT_CONFLICT', 'port ' + httpPort + ' belongs to the HTTP server; use the WebSocket gateway instead');
      if (!out.includes(raw)) out.push(raw);
    } catch (e) { rejected.push({ addr: String(raw).slice(0, 60), code: e.code || 'E_P2P_BAD_ADDR' }); }
  }
  if (!out.length) out.push(DEFAULT_LISTEN);
  return { listen: out, rejected };
}

/** For libp2p's connectionGater: look ONLY at the host component of a (possibly resolved) multiaddr string. true = deny. */
function denyPrivateHost(ma, allowPrivate = false) {
  if (allowPrivate) return false;
  const m = /^\/(ip4|ip6|dns|dns4|dns6)\/([^/]+)/.exec(String(ma));
  if (!m) return false;                                  // not an IP/DNS dial (e.g. circuit relay) — other policies apply
  const host = m[2];
  if (m[1] === 'ip4' || m[1] === 'ip6') return !isPublicIp(host);
  return /(^|\.)localhost$/i.test(host) || /\.(local|internal|lan|home|corp)$/i.test(host);
}

module.exports = { denyPrivateHost, parseMultiaddr, checkDial, normalizeListen, isLoopbackHost, P2PAddrError, DEFAULT_LISTEN };
