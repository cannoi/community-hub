'use strict';
// Transport abstraction for peer traffic. HttpTransport = HTTPS/HTTP with SSRF protection.
// The interface (request/download) is deliberately small so a direct-P2P or relay transport can be added later;
// no relay operator becomes owner of an identity because identities are verified end-to-end by signatures.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');

const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]]) blocked.addSubnet(a, p, 'ipv6');

function isPublicIp(ip) {
  const fam = net.isIP(ip);
  if (!fam) return false;
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip); // IPv4-mapped IPv6
  if (m) return isPublicIp(m[1]);
  return !blocked.check(ip, fam === 4 ? 'ipv4' : 'ipv6');
}

/** Validate and normalise a peer endpoint URL. Throws Error(code). Returns origin string. */
function validateEndpoint(raw, { allowPrivate = false } = {}) {
  const err = (c) => { const e = new Error(c); e.code = c; return e; };
  let input = String(raw || '').trim();
  // Accept bare host or host:port → assume http for public SoloHost hubs
  if (input && !/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    input = 'http://' + input;
  }
  let u; try { u = new URL(input); } catch { throw err('bad_url'); }
  if (u.username || u.password || u.hash) throw err('bad_url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.length > 253) throw err('bad_url');
  const isIp = !!net.isIP(host);
  if (isIp) { if (!allowPrivate && !isPublicIp(host)) throw err('private_address'); }
  else if (!allowPrivate && (/(^|\.)localhost$/i.test(host) || /\.(local|internal|lan|home|corp)$/i.test(host))) throw err('private_address');
  // https always OK; http allowed for public IPs (SoloHost) or when allowPrivate
  if (u.protocol === 'https:') { /* ok */ }
  else if (u.protocol === 'http:') {
    if (!(allowPrivate || isIp && isPublicIp(host))) throw err('https_required');
  } else throw err('https_required');
  return u.origin;
}

function guardedLookup(allowPrivate) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { all: true }, (e, addrs) => {
      if (e) return cb(e);
      const ok = addrs.filter((a) => allowPrivate || isPublicIp(a.address));
      if (!ok.length) { const x = new Error('private_address'); x.code = 'private_address'; return cb(x); }
      if (options && options.all) return cb(null, ok);
      cb(null, ok[0].address, ok[0].family);
    });
  };
}

class HttpTransport {
  constructor({ allowPrivate = false, timeoutMs = 8000, userAgent = 'community-hub/2' } = {}) { this.allowPrivate = allowPrivate; this.timeoutMs = timeoutMs; this.ua = userAgent; }

  _open(endpoint, { method = 'GET', path, headers = {}, body, timeoutMs }, onResponse, onError) {
    const origin = validateEndpoint(endpoint, { allowPrivate: this.allowPrivate });
    const u = new URL(path, origin);
    if (u.origin !== origin) throw Object.assign(new Error('bad_path'), { code: 'bad_path' });
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers: { 'User-Agent': this.ua, ...headers }, timeout: timeoutMs || this.timeoutMs, lookup: guardedLookup(this.allowPrivate), agent: false }, onResponse);
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })));
    req.on('error', onError);
    if (body) req.write(body);
    req.end();
    return req;
  }

  /** Bounded request → {status, headers, body:Buffer}. Redirects are never followed. */
  request(endpoint, opts, maxBytes = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      try {
        this._open(endpoint, opts, (res) => {
          const chunks = []; let n = 0;
          res.on('data', (c) => { n += c.length; if (n > maxBytes) { res.destroy(Object.assign(new Error('response_too_large'), { code: 'response_too_large' })); } else chunks.push(c); });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        }, reject);
      } catch (e) { reject(e); }
    });
  }

  /** Stream a response to a file, hashing as we go. Aborts above maxBytes. */
  download(endpoint, opts, destPath, maxBytes) {
    return new Promise((resolve, reject) => {
      try {
        this._open(endpoint, opts, (res) => {
          if (res.statusCode !== 200) { res.resume(); return reject(Object.assign(new Error('http_' + res.statusCode), { code: 'http_' + res.statusCode, status: res.statusCode })); }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) { res.destroy(); return reject(Object.assign(new Error('too_large'), { code: 'too_large' })); }
          const fd = fs.openSync(destPath, 'w', 0o600); const hash = crypto.createHash('sha256'); let size = 0; let head = Buffer.alloc(0); let done = false;
          const fail = (e) => { if (done) return; done = true; try { fs.closeSync(fd); fs.unlinkSync(destPath); } catch { /* ok */ } reject(e); };
          res.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) { res.destroy(); return fail(Object.assign(new Error('too_large'), { code: 'too_large' })); }
            if (head.length < 4096) head = Buffer.concat([head, c.subarray(0, 4096 - head.length)]);
            hash.update(c); fs.writeSync(fd, c);
          });
          res.on('end', () => { if (done) return; done = true; fs.closeSync(fd); resolve({ tmpPath: destPath, size, sha256: hash.digest('hex'), head }); });
          res.on('error', fail); res.on('aborted', () => fail(Object.assign(new Error('interrupted'), { code: 'interrupted' })));
        }, reject);
      } catch (e) { reject(e); }
    });
  }
  /**
   * Stream a peer response to callbacks (supports Range). Redirects are never followed.
   * onHeaders(status, headers) may return false to abort without reading the body.
   */
  streamProxy(endpoint, opts, { maxBytes = 50 * 1024 * 1024, onHeaders, onData, onEnd, onError } = {}) {
    return new Promise((resolve, reject) => {
      try {
        this._open(endpoint, opts, (res) => {
          const cl = Number(res.headers['content-length']);
          if (Number.isFinite(cl) && cl > maxBytes) {
            res.destroy();
            return reject(Object.assign(new Error('too_large'), { code: 'too_large' }));
          }
          if (onHeaders && onHeaders(res.statusCode, res.headers) === false) {
            res.resume();
            return resolve({ status: res.statusCode, aborted: true });
          }
          let n = 0;
          res.on('data', (c) => {
            n += c.length;
            if (n > maxBytes) {
              res.destroy();
              return reject(Object.assign(new Error('too_large'), { code: 'too_large' }));
            }
            if (onData) onData(c);
          });
          res.on('end', () => { if (onEnd) onEnd(); resolve({ status: res.statusCode, bytes: n }); });
          res.on('error', (e) => { if (onError) onError(e); reject(e); });
        }, (e) => { if (onError) onError(e); reject(e); });
      } catch (e) { reject(e); }
    });
  }

}
module.exports = { HttpTransport, validateEndpoint, isPublicIp };
