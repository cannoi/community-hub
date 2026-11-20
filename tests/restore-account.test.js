'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { startHub, Client, tmp, PNG, formWith } = require('./helpers');
const { createBackup, createBackupZip } = require('../src/backup');
const { packDirToZip, unpackZip } = require('../src/backup-zip');

const PW = 'correct-horse-9';

async function sourceHub(extra = {}) {
  const A = await startHub(extra);
  const c = new Client(A.base);
  await c.setup('owner', PW, { display_name: 'Owner Name' });
  const f = formWith({ file: { filename: 'a.png', contentType: 'image/png', buffer: PNG } });
  const up = await c.req('POST', '/api/media', f.body, { contentType: f.contentType });
  assert.ok([200, 201].includes(up.status), up.text);
  const hash = up.json.hash;
  const p = await c.post('/api/posts', { content: 'hello #restore', media: [hash] });
  assert.equal(p.status, 201, p.text);
  await c.post('/api/posts', { content: 'second post' });
  await c.patch('/api/me', { bio: 'my bio' });
  return { A, c, hash, accountId: (await c.get('/api/me')).json.user.account_id };
}
function mkZip(A, mutate) {
  const dir = tmp('bkz'); const folder = path.join(dir, 'f');
  createBackup(A.cfg, folder, A.db);
  if (mutate) mutate(folder);
  const zip = path.join(dir, 'b.zip'); packDirToZip(folder, zip);
  return fs.readFileSync(zip);
}
const rehash = (folder) => {
  const crypto = require('crypto'); const mf = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  for (const f of Object.keys(mf.files)) mf.files[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, f))).digest('hex');
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(mf));
};
async function restoreVia(B, buf, headers = {}) {
  const c = new Client(B.base);
  const f = formWith({ file: { filename: 'b.zip', contentType: 'application/zip', buffer: buf } });
  const r = await c.req('POST', '/api/setup/restore', f.body, { contentType: f.contentType, headers });
  return { c, r };
}

test('restore on setup: full round trip with key; account continues without fork', async () => {
  const { A, hash, accountId } = await sourceHub();
  const buf = mkZip(A); await A.stop();
  const B = await startHub();
  try {
    const { r } = await restoreVia(B, buf);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.key_missing, false);
    assert.equal(r.json.counts.posts, 2); assert.equal(r.json.verify.problems, 0);
    const c = new Client(B.base); await c.login('owner', PW);
    const me = (await c.get('/api/me')).json.user;
    assert.equal(me.account_id, accountId); assert.equal(me.key_missing, false); assert.equal(me.display_name, 'Owner Name');
    assert.equal((await c.get('/media/' + hash)).status, 200);
    assert.equal((await c.post('/api/posts', { content: 'after restore' })).status, 201);
    assert.deepEqual(B.ledger.verifyAll().problems, []);
  } finally { await B.stop(); }
});

test('restore refused when Hub already has an owner, bad zip, corrupt zip, not a backup', async () => {
  const { A } = await sourceHub(); const buf = mkZip(A);
  const B = await startHub();
  try {
    assert.equal((await restoreVia(B, Buffer.from('not a zip'))).r.json.code, 'E_RESTORE_BAD_ZIP');
    const bad = mkZip(A, (f) => fs.appendFileSync(path.join(f, 'community.db'), 'x'));
    assert.equal((await restoreVia(B, bad)).r.json.code, 'E_RESTORE_CORRUPT');
    const nomf = mkZip(A, (f) => fs.unlinkSync(path.join(f, 'manifest.json')));
    assert.equal((await restoreVia(B, nomf)).r.json.code, 'E_RESTORE_BAD_BACKUP');
    assert.equal((await restoreVia(B, buf)).r.status, 200);
    assert.equal((await restoreVia(B, buf)).r.status, 409);
    assert.equal((await new Client(B.base).post('/api/admin/restore', {})).status, 404, 'old live-restore route is gone');
  } finally { await B.stop(); await A.stop(); }
});

test('backup without the account key: restore works, posting is blocked, rekey recovers and old posts survive reindex', async () => {
  const { A } = await sourceHub();
  const info = createBackup(A.cfg, tmp('bkw'), A.db); assert.deepEqual(info.keys_missing, []);
  const buf = mkZip(A, (f) => { const k = path.join(f, 'keys', 'keystore.json'); const j = JSON.parse(fs.readFileSync(k, 'utf8')); j.keys = {}; fs.writeFileSync(k, JSON.stringify(j)); rehash(f); });
  const B = await startHub();
  try {
    const { r } = await restoreVia(B, buf);
    assert.equal(r.status, 200, r.text); assert.equal(r.json.key_missing, true);
    const c = new Client(B.base); await c.login('owner', PW);
    assert.equal((await c.get('/api/me')).json.user.key_missing, true);
    assert.equal((await c.post('/api/posts', { content: 'x' })).status, 403);
    assert.equal((await c.post('/api/identity/rekey', { password: 'wrong-password' })).status, 403);
    const rk = await c.post('/api/identity/rekey', { password: PW });
    assert.equal(rk.status, 200, rk.text); assert.ok(rk.json.account_id !== rk.json.old_account_id);
    assert.equal((await c.post('/api/posts', { content: 'new key post' })).status, 201);
    assert.equal((await c.post('/api/identity/rekey', { password: PW })).status, 409);
    const before = B.db.all("SELECT id FROM posts WHERE user_id=1 AND deleted_at IS NULL").length;
    assert.equal(before, 3);
    B.ledger.reindex();
    assert.equal(B.db.all("SELECT id FROM posts WHERE user_id=1 AND deleted_at IS NULL").length, 3, 'old posts stay with the owner after reindex');
    assert.equal(B.db.all("SELECT id FROM users WHERE status='remote'").length, 0);
    const old = B.db.get("SELECT id FROM posts WHERE content LIKE 'hello%'");
    assert.equal((await c.patch('/api/posts/' + old.id, { content: 'edited old' })).status, 200);
  } finally { await B.stop(); await A.stop(); }
});

test('setup token is checked before the upload is read', async () => {
  const { A } = await sourceHub(); const buf = mkZip(A);
  const B = await startHub({ setupToken: 'tok-123' });
  try {
    assert.equal((await restoreVia(B, buf)).r.status, 403);
    assert.equal((await restoreVia(B, buf, { 'X-Setup-Token': 'tok-123' })).r.status, 200);
  } finally { await B.stop(); await A.stop(); }
});

test('zip reader: data-descriptor zip and wrapper directory', async () => {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }; const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const files = { 'w/a.txt': Buffer.from('hello world hello world'), 'w/sub/b.txt': Buffer.from('b') };
  const parts = []; const cds = []; let off = 0;
  for (const [n, d] of Object.entries(files)) {
    const nb = Buffer.from(n); const comp = zlib.deflateRawSync(d); const cr = crc(d);
    const l = Buffer.concat([u32(0x04034b50), u16(20), u16(8), u16(8), u16(0), u16(0), u32(0), u32(0), u32(0), u16(nb.length), u16(0), nb, comp, u32(0x08074b50), u32(cr), u32(comp.length), u32(d.length)]);
    cds.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(8), u16(8), u16(0), u16(0), u32(cr), u32(comp.length), u32(d.length), u16(nb.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), nb]));
    parts.push(l); off += l.length;
  }
  const cd = Buffer.concat(cds);
  const zip = Buffer.concat([...parts, cd, u32(0x06054b50), u16(0), u16(0), u16(2), u16(2), u32(cd.length), u32(off), u16(0)]);
  const zf = path.join(tmp('zz'), 'x.zip'); fs.writeFileSync(zf, zip);
  const out = tmp('zo'); unpackZip(zf, out);
  assert.equal(fs.readFileSync(path.join(out, 'w/a.txt'), 'utf8'), 'hello world hello world');
  assert.equal(fs.readFileSync(path.join(out, 'w/sub/b.txt'), 'utf8'), 'b');
});

test('explore/search view never passes an array to DOM append()', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'views.js'), 'utf8');
  assert.match(src, /\.\.\.r\.accounts\.map\(userRow\)/);
  assert.match(src, /\.\.\.r\.posts\.map\(\(p\) => postCard\(p\)\)/);
  assert.doesNotMatch(src, /out\.append\([^;]*[^.]r\.(accounts|posts)\.map\(/);
});

test('setup UI: zip restore present, key import removed; settings restore removed', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const views = fs.readFileSync(path.join(__dirname, '..', 'public', 'views.js'), 'utf8');
  assert.match(app, /\/api\/setup\/restore/); assert.doesNotMatch(app, /su-file|su-ipass|auth\.importKey/);
  assert.doesNotMatch(views, /restore-zip|\/api\/admin\/restore/);
});
