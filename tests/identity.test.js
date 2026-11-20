'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { startHub, Client, tmp } = require('./helpers');
const { isAccountId } = require('../src/keystore');

test('A1/A2 identity is created once and survives restart; key file protected', async () => {
  const dir = tmp('id');
  let hub = await startHub({ dataDir: dir }); let c = new Client(hub.base);
  assert.equal((await c.get('/api/session')).json.setup_required, true);
  const s = await c.setup('owner');
  assert.ok(isAccountId(s.account_id));
  assert.equal((await c.post('/api/setup', { username: 'x1x', password: 'abcdefgh12' })).status, 409, 'cannot create a second default identity');
  await hub.stop();
  const mode = fs.statSync(path.join(dir, 'keys', 'keystore.json')).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'keys')).mode & 0o777, 0o700);
  hub = await startHub({ dataDir: dir }); c = new Client(hub.base);
  const sess = await c.get('/api/session'); assert.equal(sess.json.setup_required, false);
  await c.login('owner');
  assert.equal((await c.get('/api/identity')).json.account_id, s.account_id);
  await hub.stop();
});

test('A3/A4 forged actor, invalid signature and unauthorized actions are rejected', async () => {
  const hub = await startHub({ allowRegistration: true });
  const owner = new Client(hub.base); await owner.setup('owner');
  const bob = new Client(hub.base); await bob.post('/api/register', { username: 'bob', password: 'bobpassword1' });
  const ownerId = (await owner.get('/api/me')).json.user.id; const bobId = (await bob.get('/api/me')).json.user.id;
  // spoofing user_id
  assert.equal((await bob.post('/api/posts', { content: 'hi', user_id: ownerId })).status, 403);
  assert.equal((await new Client(hub.base).post('/api/posts', { content: 'anon' })).status, 401);
  const p = (await owner.post('/api/posts', { content: 'owner post' })).json.post;
  // edits / deletes of someone else's post
  assert.equal((await bob.patch(`/api/posts/${p.id}`, { content: 'hijack' })).status, 403);
  assert.equal((await bob.del(`/api/posts/${p.id}`)).status, 403);
  // reactions need auth
  assert.equal((await new Client(hub.base).post(`/api/posts/${p.id}/react`, {})).status, 401);
  assert.equal((await bob.post(`/api/posts/${p.id}/react`, { user_id: ownerId })).status, 403);
  // group membership
  const g = (await owner.post('/api/groups', { name: 'Secret', visibility: 'private' })).json;
  assert.equal((await bob.post(`/api/groups/${g.id}/join`, {})).status, 403, 'private group join refused');
  assert.equal((await bob.post(`/api/groups/${g.id}/members`, { user_id: bobId })).status, 403, 'non-admin cannot add members');
  assert.equal((await bob.get(`/api/groups/${g.id}/posts`)).status, 404, 'private group hidden from non-members');
  assert.equal((await bob.post(`/api/groups/${g.id}/posts.json`, { content: 'x' })).status, 403);
  assert.equal((await owner.post(`/api/groups/${g.id}/members`, { user_id: bobId })).status, 200);
  assert.equal((await bob.patch(`/api/groups/${g.id}/members/${ownerId}`, { role: 'member' })).status, 403, 'member cannot demote admin');
  // forged / badly signed federation-style events through the owner import endpoint
  const evs = (await owner.get('/api/admin/export/events')).text.trim().split('\n').map((l) => JSON.parse(l));
  const forged = { ...evs[0], actor_id: 'hub1_' + 'a'.repeat(52) };
  const badsig = { ...evs[0], signature: 'A'.repeat(86) };
  const r = await owner.post('/api/admin/import/events', { events: [forged, badsig] });
  assert.equal(r.json.rejected, 2);
  // bob is not the owner: owner-only endpoints
  assert.equal((await bob.get('/api/peers')).status, 403);
  assert.equal((await bob.post('/api/admin/reindex', {})).status, 403);
  await hub.stop();
});

test('A5 private keys never appear in API output, logs or on disk in plaintext', async () => {
  const hub = await startHub({ allowRegistration: true });
  const c = new Client(hub.base); const s = await c.setup('owner');
  const priv = hub.ks._priv(s.account_id).export({ format: 'der', type: 'pkcs8' });
  const secrets = [priv.toString('base64'), priv.toString('base64url'), priv.toString('hex'), priv.subarray(16).toString('base64url')];
  const bodies = [];
  for (const p of ['/api/session', '/api/me', '/api/identity', '/api/sync/status', '/api/peers', '/api/users', '/api/feed/public', `/api/profiles/owner`, '/api/admin/export/events', '/api/admin/integrity']) bodies.push((await c.get(p)).text);
  bodies.push((await c.post('/api/posts', { content: 'x' })).text);
  const keyfile = fs.readFileSync(path.join(hub.dir, 'keys', 'keystore.json'), 'utf8');
  const db = fs.readFileSync(hub.cfg.dbFile);
  for (const sec of secrets) {
    for (const b of bodies) assert.ok(!b.includes(sec));
    assert.ok(!keyfile.includes(sec)); assert.ok(!db.includes(Buffer.from(sec)));
  }
  assert.ok(!fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').includes('PRIVATE KEY'));
  // export requires password and a strong passphrase; wrong password refused
  assert.equal((await c.post('/api/identity/export', { password: 'wrong-password', export_passphrase: 'a-long-passphrase' })).status, 403);
  assert.equal((await c.post('/api/identity/export', { password: 'correct-horse-9', export_passphrase: 'short' })).status, 400);
  const ex = await c.post('/api/identity/export', { password: 'correct-horse-9', export_passphrase: 'a-long-passphrase' });
  assert.equal(ex.status, 200); assert.ok(!ex.text.includes(secrets[0]), 'export is encrypted');
  await hub.stop();
});

test('login is rate limited and generic; sessions use hardened cookies', async () => {
  const hub = await startHub({ rateLimit: { general: 600, write: 90, login: 100, upload: 20, federation: 240, assistant: 20 } });
  const c = new Client(hub.base); await c.setup('owner');
  const c2 = new Client(hub.base);
  const bad = await c2.post('/api/login', { username: 'owner', password: 'nope-nope-nope' });
  const none = await c2.post('/api/login', { username: 'ghost', password: 'nope-nope-nope' });
  assert.equal(bad.status, 401); assert.deepEqual(bad.json, none.json);
  const res = await new Client(hub.base).req('POST', '/api/login', { username: 'owner', password: 'correct-horse-9' }, { raw: true });
  const ck = res.headers.getSetCookie()[0]; assert.match(ck, /HttpOnly/); assert.match(ck, /SameSite=Lax/);
  // CSRF: authenticated write without token / with foreign origin
  const noTok = new Client(hub.base); await noTok.login('owner'); noTok.csrf = '';
  assert.equal((await noTok.post('/api/posts', { content: 'x' })).status, 403);
  const ok = new Client(hub.base); await ok.login('owner');
  assert.equal((await ok.req('POST', '/api/posts', { content: 'x' }, { headers: { origin: 'http://evil.example' } })).status, 403);
  let last; for (let i = 0; i < 12; i++) last = await c2.post('/api/login', { username: 'owner', password: 'nope-nope-nope' });
  assert.equal(last.status, 429);
  await hub.stop();
});

test('legacy database is adopted: data kept, nobody silently gets a key, explicit claim works', async () => {
  const dir = tmp('legacy'); fs.mkdirSync(dir, { recursive: true });
  const old = new DatabaseSync(path.join(dir, 'community.db'));
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, avatar TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, description TEXT, owner_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE group_members (group_id INTEGER, user_id INTEGER, role TEXT, joined_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (group_id, user_id));
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER, user_id INTEGER, content TEXT, file_url TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, user_id INTEGER, content TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE reactions (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, user_id INTEGER, type TEXT, UNIQUE(post_id, user_id));
    INSERT INTO users(username,avatar) VALUES('Alice','https://api.dicebear.com/x/a'),('Bob','x');
    INSERT INTO groups(name,description,owner_id) VALUES('Tech Enthusiasts','d',1);
    INSERT INTO group_members(group_id,user_id,role) VALUES(1,1,'admin'),(1,2,'member');
    INSERT INTO posts(group_id,user_id,content,file_url) VALUES(1,1,'Welcome!',NULL),(1,2,'with file','/uploads/123-456-note.txt');
    INSERT INTO comments(post_id,user_id,content) VALUES(1,2,'nice');
    INSERT INTO reactions(post_id,user_id,type) VALUES(1,2,'like');`);
  old.close();
  fs.mkdirSync(path.join(dir, 'uploads', 'legacy'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploads', 'legacy', '123-456-note.txt'), '<script>alert(1)</script>');
  const hub = await startHub({ dataDir: dir });
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('pre-upgrade')), 'safety copy of legacy DB created');
  const c = new Client(hub.base);
  const sess = (await c.get('/api/session')).json;
  assert.deepEqual(sess.legacy_users.map((u) => u.username), ['Alice', 'Bob']);
  assert.equal(hub.db.get("SELECT COUNT(*) c FROM users WHERE account_id IS NOT NULL").c, 0, 'no legacy user silently received a key');
  await c.setup('Alice', 'correct-horse-9', { claim_legacy_user_id: 1 });
  assert.equal(hub.db.get("SELECT status FROM users WHERE username='Bob'").status, 'legacy', 'Bob stays unclaimed');
  const posts = (await c.get('/api/groups/1/posts')).json;
  assert.equal(posts.length, 2); assert.ok(posts.every((p) => 'reaction_count' in p && 'comment_count' in p && 'username' in p));
  assert.equal(posts.find((p) => p.content === 'Welcome!').username, 'Alice');
  assert.equal(posts.find((p) => p.content === 'Welcome!').comment_count, 1);
  assert.equal(posts.find((p) => p.content === 'Welcome!').reaction_count, 1);
  assert.equal((await c.get('/api/groups/1/members')).json.length, 2);
  // old upload still downloadable, but never rendered inline as HTML
  const f = await c.get('/uploads/123-456-note.txt', { raw: true });
  assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'application/octet-stream'); assert.match(f.headers.get('content-disposition'), /attachment/);
  assert.equal((await new Client(hub.base).get('/uploads/123-456-note.txt', { raw: true })).status, 401);
  assert.equal((await c.get('/uploads/..%2F..%2Fetc%2Fpasswd', { raw: true })).status, 404);
  await hub.stop();
});
