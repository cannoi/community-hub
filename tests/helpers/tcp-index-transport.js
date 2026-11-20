'use strict';
// Multi-PROCESS simulation transport: length-prefixed JSON over real 127.0.0.1 TCP sockets.
// libp2p/Noise is not available offline, so peer identity is authenticated here by an Ed25519 signature over (to, ts, body).
const net = require('net');
const C = require('../../src/net/p2p/index-crypto');
const MAX = 1024 * 1024;
class TcpIndexTransport {
  constructor({ signer, directory }) { this.signer = signer; this.dir = directory; this.server = null; this.port = 0; }
  async start(handler) {
    this.server = net.createServer((sock) => {
      let buf = Buffer.alloc(0); let done = false;
      sock.on('data', async (d) => {
        buf = Buffer.concat([buf, d]); if (done || buf.length < 4) return;
        const n = buf.readUInt32BE(0); if (n > MAX) return sock.destroy();
        if (buf.length < 4 + n) return; done = true;
        try {
          const env = JSON.parse(buf.subarray(4, 4 + n).toString());
          const ok = Math.abs(Date.now() - env.ts) < 60000 && env.to === this.signer.peerId && await this.signer.verify(`${env.to}|${env.ts}|${env.body}`, env.sig, env.from);
          const resp = ok ? await handler(env.from, JSON.parse(env.body)) : { ok: false, reason: 'unauthenticated' };
          const out = Buffer.from(JSON.stringify(resp)); const hdr = Buffer.alloc(4); hdr.writeUInt32BE(out.length);
          sock.end(Buffer.concat([hdr, out]));
        } catch { sock.destroy(); }
      });
      sock.on('error', () => {});
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r)); this.port = this.server.address().port; return true;
  }
  async stop() { if (this.server) await new Promise((r) => this.server.close(r)); }
  async request(to, msg, { timeoutMs = 1500 } = {}) {
    const port = this.dir[to]; if (!port) throw new Error('no_route');
    const body = JSON.stringify(msg), ts = Date.now();
    const env = Buffer.from(JSON.stringify({ from: this.signer.peerId, to, ts, body, sig: await this.signer.sign(`${to}|${ts}|${body}`) }));
    const hdr = Buffer.alloc(4); hdr.writeUInt32BE(env.length);
    return await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1'); let buf = Buffer.alloc(0);
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, timeoutMs);
      sock.on('connect', () => sock.write(Buffer.concat([hdr, env])));
      sock.on('data', (d) => { buf = Buffer.concat([buf, d]); if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) { clearTimeout(timer); try { resolve(JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString())); } catch (e) { reject(e); } sock.destroy(); } });
      sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }
}
module.exports = { TcpIndexTransport };
