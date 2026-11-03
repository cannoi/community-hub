'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createHub } = require('../src/hub');

const tmp = (n = 'hub') => fs.mkdtempSync(path.join(os.tmpdir(), `${n}-`));
const silent = { error() {}, warn() {}, info() {}, debug() {} };

/** Start one independent Hub instance (own data dir, DB, keys, uploads) on an ephemeral port. */
async function startHub(over = {}) {
  const dir = over.dataDir || tmp('hub');
  const cfg = { dataDir: dir, dbFile: path.join(dir, 'community.db'), uploadDir: path.join(dir, 'uploads'), keyDir: path.join(dir, 'keys'), port: 0, host: '127.0.0.1', logger: silent, scryptN: 1024, allowPrivatePeers: true, syncIntervalMs: 300, backoffBaseMs: 50, backoffMaxMs: 400, peerTimeoutMs: 2000, ...over };
  const hub = createHub(cfg, {});
  const port = await hub.start();
  hub.base = `http://127.0.0.1:${port}`; hub.dir = dir;
  return hub;
}

class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }
  async req(method, p, body, { headers = {}, raw = false, form } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf && method !== 'GET') h['x-csrf-token'] = this.csrf;
    let payload;
    if (form) payload = form; else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(this.base + p, { method, headers: h, body: payload });
    const sc = res.headers.getSetCookie?.() || [];
    for (const c of sc) { const kv = c.split(';')[0]; if (kv.endsWith('=')) this.cookie = ''; else this.cookie = kv; }
    if (raw) return res;
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = undefined; }
    if (json && json.csrf) this.csrf = json.csrf;
    return { status: res.status, json, text, headers: res.headers };
  }
  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b, o) { return this.req('POST', p, b ?? {}, o); }
  patch(p, b) { return this.req('PATCH', p, b ?? {}); }
  put(p, b) { return this.req('PUT', p, b ?? {}); }
  del(p, b) { return this.req('DELETE', p, b); }
  async setup(username = 'owner', password = 'correct-horse-9', extra = {}) { const r = await this.post('/api/setup', { username, password, ...extra }); if (r.status !== 200) throw new Error('setup failed ' + r.text); return r.json; }
  async login(username, password = 'correct-horse-9') { const r = await this.post('/api/login', { username, password }); if (r.status !== 200) throw new Error('login failed ' + r.text); return r.json; }
}

const waitFor = async (fn, ms = 8000, step = 50) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('waitFor timeout'); await new Promise((r) => setTimeout(r, step)); } };

// Minimal valid files for media tests
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
function mp4(size = 200000) { const b = Buffer.alloc(size, 7); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'latin1'); b.writeUInt32BE(0x200, 12); b.write('isomiso2', 16, 'latin1'); return b; }
function formWith(buf, filename, fields = {}, name = 'file') { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, String(v)); f.append(name, new Blob([buf]), filename); return f; }

module.exports = { startHub, Client, waitFor, tmp, PNG, mp4, formWith, silent };
