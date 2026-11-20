'use strict';
/**
 * WebSocket gateway on the EXISTING HTTP port (8080 in SoloHost) — no second public port.
 *
 *   internet ──► :8080 (HTTP server) ──'upgrade'──► WsGateway ──TCP──► 127.0.0.1:<ephemeral> (libp2p /ws listener)
 *
 * Why: libp2p's websocket listener opens its own socket. Publishing a random extra port is impossible behind SoloHost
 * (only 8080 is mapped) and uncontrolled on any host. Instead libp2p listens on LOOPBACK and this module forwards
 * ONLY well-formed WebSocket upgrade requests (GET, Upgrade: websocket, version 13, valid key, path "/" or "/p2p[/…]")
 * to it. Plain HTTP/SSE traffic on the same port is untouched (the Hub uses SSE, never WebSocket, so "/" is unambiguous).
 *
 * Hardening: disabled unless explicitly attached; fixed loopback backend (never user-supplied); header whitelist (cookies,
 * Authorization, Origin and Sec-WebSocket-Extensions are NOT forwarded); per-IP rate limit; tunnel cap; connect + idle
 * timeouts; every error closes both sockets; close() tears all tunnels down on shutdown.
 */
const net = require('net');
const { clientIp } = require('../../http');

const KEY_RE = /^[A-Za-z0-9+/]{22}==$/;
const PROTO_RE = /^[\w.,\- ]{1,100}$/;
const pathAllowed = (url) => { const p = String(url || '/').split('?')[0]; return p === '/' || p === '/p2p' || p.startsWith('/p2p/'); };

class WsGateway {
  constructor({ server, getBackend, log = {}, limiter = null, trustProxy = 0, maxTunnels = 64, idleMs = 180000, connectMs = 3000, perIpPerMin = 30 }) {
    Object.assign(this, { server, getBackend, log, limiter, trustProxy, maxTunnels, idleMs, connectMs, perIpPerMin });
    this.tunnels = new Set(); this.attached = false; this.stats = { accepted: 0, rejected: 0, closed: 0 };
  }
  attach() { if (this.attached) return; this._h = (req, socket, head) => this._onUpgrade(req, socket, head); this.server.on('upgrade', this._h); this.attached = true; }
  detach() { if (!this.attached) return; this.server.off('upgrade', this._h); this.attached = false; }
  close() { this.detach(); for (const t of [...this.tunnels]) this._drop(t); }
  status() { return { attached: this.attached, active: this.tunnels.size, ...this.stats, max: this.maxTunnels }; }

  _reject(socket, code, text) {
    this.stats.rejected++;
    try { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* closed */ }
    const t = setTimeout(() => socket.destroy(), 1000); t.unref();
  }
  _drop(t) {
    if (!this.tunnels.delete(t)) return;
    this.stats.closed++;
    try { t.socket.destroy(); } catch { /* ignore */ } try { t.up.destroy(); } catch { /* ignore */ }
  }

  _onUpgrade(req, socket, head) {
    socket.on('error', () => {});
    try {
      const h = req.headers;
      const connOk = /(^|,\s*)upgrade(\s*,|$)/i.test(String(h.connection || ''));
      if (req.method !== 'GET' || String(h.upgrade || '').toLowerCase() !== 'websocket' || !connOk || h['sec-websocket-version'] !== '13' || !KEY_RE.test(String(h['sec-websocket-key'] || ''))) return this._reject(socket, 400, 'Bad Request');
      if (!pathAllowed(req.url)) return this._reject(socket, 404, 'Not Found');
      if (this.limiter) {
        const ip = clientIp(req, this.trustProxy);
        if (this.limiter.check('p2pws:' + ip, this.perIpPerMin)) return this._reject(socket, 429, 'Too Many Requests');
      }
      if (this.tunnels.size >= this.maxTunnels) return this._reject(socket, 503, 'Service Unavailable');
      const b = this.getBackend();
      if (!b || b.host !== '127.0.0.1' || !Number.isInteger(b.port)) return this._reject(socket, 503, 'Service Unavailable'); // loopback only
      const proto = h['sec-websocket-protocol'];
      let headText = `GET / HTTP/1.1\r\nHost: 127.0.0.1:${b.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${h['sec-websocket-key']}\r\nSec-WebSocket-Version: 13\r\n`;
      if (typeof proto === 'string' && PROTO_RE.test(proto)) headText += `Sec-WebSocket-Protocol: ${proto}\r\n`;
      headText += '\r\n';

      const up = net.connect({ host: b.host, port: b.port });
      const t = { socket, up }; this.tunnels.add(t); this.stats.accepted++;
      let connected = false;
      const drop = () => this._drop(t);
      const ct = setTimeout(() => { if (!connected) { this._reject(socket, 504, 'Gateway Timeout'); drop(); } }, this.connectMs); ct.unref();
      up.setNoDelay(true);
      up.on('connect', () => {
        connected = true; clearTimeout(ct);
        up.write(headText); if (head && head.length) up.write(head);
        socket.pipe(up); up.pipe(socket);
        socket.setTimeout(this.idleMs); socket.on('timeout', drop);
      });
      up.on('error', () => { if (!connected) this._reject(socket, 502, 'Bad Gateway'); drop(); });
      socket.on('error', drop); socket.on('close', drop); up.on('close', drop);
    } catch (e) { try { socket.destroy(); } catch { /* ignore */ } if (this.log.warn) this.log.warn('ws gateway: ' + (e && e.message)); }
  }
}
module.exports = { WsGateway, pathAllowed };
