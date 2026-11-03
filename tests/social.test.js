'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startHub, Client, PNG, mp4, formWith } = require('./helpers');

async function duo(over = {}) {
  const hub = await startHub({ allowRegistration: true, rateLimit: { general: 5000, write: 5000, login: 500, upload: 500, federation: 500, assistant: 50 }, ...over });
  const o = new Client(hub.base); await o.setup('owner');
  const b = new Client(hub.base); await b.post('/api/register', { username: 'bob', password: 'bobpassword1' });
  const oa = (await o.get('/api/me')).json.user; const ba = (await b.get('/api/me')).json.user;
  return { hub, o, b, oa, ba };
}
const upload = (c, buf, name) => c.req('POST', '/api/media', undefined, { form: formWith(buf, name) });

test('D18 posts, replies, reactions, reposts, quotes, follows, bookmarks, notifications, edit/delete', async () => {
  const { hub, o, b, oa, ba } = await duo();
  const p = (await o.post('/api/posts', { content: 'Hello #Hub world', client_id: 'c1' })).json.post;
  assert.equal((await o.post('/api/posts', { content: 'Hello #Hub world', client_id: 'c1' })).json.duplicate, true, 'retry with same client_id does not double-post');
  assert.equal(hub.db.get("SELECT COUNT(*) c FROM posts WHERE content='Hello #Hub world'").c, 1);
  assert.equal((await b.post(`/api/posts/${p.id}/react`, {})).json.reacted, true);
  assert.equal((await b.post('/api/posts', { content: 'nice one', reply_to: p.id })).status, 201);
  assert.equal((await b.post('/api/posts', { repost_of: p.id })).status, 201);
  assert.equal((await b.post('/api/posts', { content: 'quoting', quote_of: p.id })).status, 201);
  assert.equal((await b.post('/api/posts', { repost_of: p.id })).status, 409, 'cannot repost twice');
  const one = (await b.get(`/api/posts/${p.id}`)).json;
  assert.deepEqual([one.counts.likes, one.counts.replies, one.counts.reposts, one.counts.quotes], [1, 1, 1, 1]);
  assert.equal(one.viewer.liked, true); assert.equal(one.viewer.reposted, true);
  assert.equal((await b.post(`/api/posts/${p.id}/react`, {})).json.reacted, false, 'toggle off');
  // follow → home feed; friends = mutual
  assert.equal((await b.post('/api/follow', { account_id: oa.account_id })).json.following, true);
  assert.equal((await b.get('/api/feed/home')).json.items.some((x) => x.id === p.id), true);
  assert.equal((await o.post('/api/follow', { account_id: ba.account_id })).status, 200);
  const prof = (await o.get('/api/profiles/bob')).json; assert.equal(prof.relation.friend, true); assert.equal(prof.counts.followers, 1);
  assert.equal((await o.get('/api/profiles/owner/followers')).json.items[0].username, 'bob');
  assert.equal((await o.post('/api/follow', { account_id: oa.account_id })).status, 400, 'no self-follow');
  // bookmarks (local) and notifications
  assert.equal((await b.post(`/api/bookmarks/${p.id}`, {})).json.bookmarked, true);
  assert.equal((await b.get('/api/bookmarks')).json.items.length, 1);
  assert.equal((await o.get('/api/bookmarks')).json.items.length, 0, 'bookmarks are private');
  const n = (await o.get('/api/notifications')).json;
  assert.ok(['like', 'reply', 'repost', 'quote', 'follow'].every((t) => n.items.some((x) => x.type === t)), 'notification types: ' + n.items.map((x) => x.type));
  // edit / delete (tombstone)
  assert.equal((await o.patch(`/api/posts/${p.id}`, { content: 'Edited #changed' })).json.content, 'Edited #changed');
  assert.ok((await o.get('/api/search?q=%23changed')).json.posts.length === 1 && (await o.get('/api/search?q=%23hub')).json.posts.length === 0);
  const del = (await o.del(`/api/posts/${p.id}`)).json; assert.equal(del.note, 'tombstone_published');
  assert.equal((await b.get(`/api/posts/${p.id}`)).json.deleted, true);
  assert.equal((await b.get('/api/feed/home')).json.items.some((x) => x.id === p.id), false);
  assert.ok(hub.db.get("SELECT 1 x FROM events WHERE event_type='post.delete'"));
  await hub.stop();
});

test('D19 cursor pagination is stable, complete and permission-aware', async () => {
  const { hub, o, b, oa } = await duo();
  for (let i = 1; i <= 25; i++) await o.post('/api/posts', { content: `post ${i}` });
  await o.post('/api/posts', { content: 'followers-only', visibility: 'followers' });
  const seen = []; let cursor = null; let pages = 0;
  for (;;) {
    const r = (await new Client(hub.base).get(`/api/feed/public?limit=10${cursor ? '&cursor=' + cursor : ''}`)).json;
    seen.push(...r.items.map((x) => x.id)); pages++;
    if (pages === 1) await o.post('/api/posts', { content: 'arrives between pages' }); // must not shift later pages
    if (!r.next_cursor) break; cursor = r.next_cursor;
  }
  assert.equal(pages, 3); assert.equal(seen.length, 25); assert.equal(new Set(seen).size, 25, 'no duplicates or skips');
  const anon = (await new Client(hub.base).get('/api/feed/public?limit=50')).json.items;
  assert.ok(!anon.some((x) => x.content === 'followers-only'), 'anonymous cannot see followers-only');
  assert.ok(!(await b.get('/api/feed/public?limit=50')).json.items.some((x) => x.content === 'followers-only'), 'non-follower cannot see');
  await b.post('/api/follow', { account_id: oa.account_id });
  const prof = (await b.get('/api/profiles/owner/posts?limit=50')).json.items;
  assert.ok(prof.some((x) => x.content === 'followers-only'), 'follower can see');
  assert.equal((await new Client(hub.base).get('/api/feed/home')).status, 401);
  assert.equal((await b.get('/api/feed/public?cursor=garbage!!')).status, 200, 'bad cursor is ignored safely');
  assert.equal((await b.get('/api/feed/public?limit=99999')).json.items.length <= 50, true);
  // blocking hides content; muting hides from feeds
  await b.post('/api/blocks', { account_id: oa.account_id });
  assert.ok(!(await b.get('/api/feed/public?limit=50')).json.items.some((x) => x.author.account_id === oa.account_id));
  assert.equal((await b.get(`/api/posts/${seen[0]}`)).status, 404);
  await hub.stop();
});

test('D20/D21 image upload, retrieval, validation, quotas and safe naming', async () => {
  const { hub, o } = await duo({ maxUploadBytes: 300 * 1024, userQuotaBytes: 400 * 1024 });
  const ok = await upload(o, PNG, '../../evil name.png');
  assert.equal(ok.status, 200); assert.equal(ok.json.kind, 'image'); assert.equal(ok.json.mime, 'image/png'); assert.match(ok.json.hash, /^[0-9a-f]{64}$/);
  assert.ok(!ok.json.name.includes('/') && !ok.json.name.includes('..'));
  const fs = require('fs'); const files = fs.readdirSync(hub.cfg.uploadDir, { recursive: true }).join(' ');
  assert.ok(!files.includes('evil'), 'user filename never used on disk');
  const got = await new Client(hub.base).get('/media/' + ok.json.hash, { raw: true });
  assert.equal(got.status, 404, 'unattached media is private to its uploader');
  const post = (await o.post('/api/posts', { content: 'pic', media: [ok.json.hash] })).json.post;
  const pub = await new Client(hub.base).get('/media/' + ok.json.hash, { raw: true });
  assert.equal(pub.status, 200); assert.equal(pub.headers.get('content-type'), 'image/png'); assert.equal(pub.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await pub.arrayBuffer()), PNG);
  assert.equal(post.media[0].kind, 'image');
  assert.equal((await upload(o, Buffer.from('<html><script>alert(1)</script></html>'), 'x.png')).status, 415, 'html disguised as png');
  assert.equal((await upload(o, Buffer.from('MZ\x90\x00 fake exe'), 'setup.exe')).status, 415);
  assert.equal((await upload(o, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg')).status, 415, 'svg refused');
  assert.equal((await upload(o, Buffer.alloc(0), 'empty.png')).status, 400);
  assert.equal((await upload(o, Buffer.concat([PNG, Buffer.alloc(350 * 1024)]), 'big.png')).status, 413, 'oversized');
  assert.equal((await upload(o, Buffer.concat([PNG, Buffer.alloc(250 * 1024, 1)]), 'a.png')).status, 200);
  assert.equal((await upload(o, Buffer.concat([PNG, Buffer.alloc(250 * 1024, 2)]), 'b.png')).status, 413, 'quota exceeded');
  assert.equal((await new Client(hub.base).req('POST', '/api/media', undefined, { form: formWith(PNG, 'a.png') })).status, 401);
  assert.equal(fs.readdirSync(require('path').join(hub.cfg.uploadDir, 'tmp')).length, 0, 'no temp files left behind');
  await hub.stop();
});

test('D22 video: HTTP range requests, seeking, HEAD, limits; audio and documents', async () => {
  const { hub, o } = await duo({ maxRangeBytes: 64 * 1024 });
  const buf = mp4(200000);
  const up = (await upload(o, buf, 'clip.mp4')).json; assert.equal(up.kind, 'video'); assert.equal(up.mime, 'video/mp4');
  await o.post('/api/posts', { content: 'video', media: [up.hash] });
  const u = '/media/' + up.hash; const anon = new Client(hub.base);
  const full = await anon.get(u, { raw: true });
  assert.equal(full.status, 200); assert.equal(full.headers.get('accept-ranges'), 'bytes'); assert.equal(Number(full.headers.get('content-length')), 200000);
  const part = await anon.get(u, { raw: true, headers: { range: 'bytes=100-199' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 100-199/200000');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), buf.subarray(100, 200));
  const seek = await anon.get(u, { raw: true, headers: { range: 'bytes=100000-' } });
  assert.equal(seek.status, 206); const sb = Buffer.from(await seek.arrayBuffer());
  assert.equal(sb.length, 64 * 1024, 'range response capped by maxRangeBytes'); assert.deepEqual(sb, buf.subarray(100000, 100000 + 64 * 1024));
  const suffix = await anon.get(u, { raw: true, headers: { range: 'bytes=-500' } });
  assert.equal(suffix.headers.get('content-range'), 'bytes 199500-199999/200000');
  assert.equal((await anon.get(u, { raw: true, headers: { range: 'bytes=999999-' } })).status, 416);
  assert.equal((await anon.get(u, { raw: true, headers: { range: 'bytes=5-2' } })).status, 416);
  assert.equal((await anon.get(u, { raw: true, headers: { range: 'bytes=0-1,5-9' } })).status, 200, 'multi-range ignored');
  const head = await anon.req('HEAD', u, undefined, { raw: true }); assert.equal(head.status, 200);
  // audio + document
  const mp3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'), Buffer.alloc(2000, 9)]);
  const au = (await upload(o, mp3, 'song.mp3')).json; assert.equal(au.kind, 'audio');
  const doc = (await upload(o, Buffer.from('%PDF-1.4 test'), 'paper.pdf')).json; assert.equal(doc.kind, 'document');
  await o.post('/api/posts', { content: 'files', media: [au.hash, doc.hash] });
  const d = await anon.get('/media/' + doc.hash, { raw: true });
  assert.match(d.headers.get('content-disposition'), /attachment/); assert.match(d.headers.get('content-security-policy'), /sandbox/);
  await hub.stop();
});

test('D23 restricted media is not publicly accessible (followers, group, private group)', async () => {
  const { hub, o, b, oa } = await duo();
  const m = (await upload(o, Buffer.concat([PNG, Buffer.from('r1')]), 'r.png')).json;
  await o.post('/api/posts', { content: 'private pic', media: [m.hash], visibility: 'followers' });
  const anon = new Client(hub.base);
  assert.equal((await anon.get('/media/' + m.hash, { raw: true })).status, 404);
  assert.equal((await b.get('/media/' + m.hash, { raw: true })).status, 404);
  assert.equal((await o.get('/media/' + m.hash, { raw: true })).status, 200, 'owner can');
  await b.post('/api/follow', { account_id: oa.account_id });
  assert.equal((await b.get('/media/' + m.hash, { raw: true })).status, 200, 'follower can');
  // private group
  const g = (await o.post('/api/groups', { name: 'Closed', visibility: 'private' })).json;
  const gm = (await upload(o, Buffer.concat([PNG, Buffer.from('g1')]), 'g.png')).json;
  const form = formWith(PNG, 'ignored.png', { content: 'group file' }); // via legacy multipart endpoint
  const gp = await o.req('POST', `/api/groups/${g.id}/posts`, undefined, { form }); assert.equal(gp.status, 200);
  const gh = gp.json.file_url.split('/').pop();
  assert.equal((await b.get('/media/' + gh, { raw: true })).status, 404, 'non-member cannot fetch private group file');
  assert.equal((await anon.get('/media/' + gh, { raw: true })).status, 404);
  await o.post(`/api/groups/${g.id}/members`, { user_id: (await b.get('/api/me')).json.user.id });
  assert.equal((await b.get('/media/' + gh, { raw: true })).status, 200, 'member can');
  // group & restricted content never appears in search
  assert.equal((await b.get('/api/search?q=private%20pic')).json.posts.length, 1 /* b follows owner now */);
  assert.equal((await anon.get('/api/search?q=private')).json.posts.length, 0);
  await hub.stop();
});

test('D24 existing groups & file sharing flow (legacy API shapes) still works end-to-end', async () => {
  const { hub, o, b, ba } = await duo();
  const g = (await o.post('/api/groups', { name: 'Tech Enthusiasts', description: 'Talk tech' })).json;
  assert.ok(g.id && g.name === 'Tech Enthusiasts');
  assert.ok((await b.get('/api/groups')).json.some((x) => x.id === g.id && x.member_count === 1 && x.owner_name === 'owner'));
  assert.equal((await b.post(`/api/groups/${g.id}/posts.json`, { content: 'not yet member' })).status, 403);
  assert.equal((await b.post(`/api/groups/${g.id}/join`, { user_id: ba.id })).json.success, true);
  const post = await b.req('POST', `/api/groups/${g.id}/posts`, undefined, { form: formWith(Buffer.from('hello notes'), 'notes.txt', { content: 'my notes', user_id: ba.id }) });
  assert.equal(post.status, 200); assert.equal(post.json.content, 'my notes'); assert.equal(post.json.group_id, g.id);
  const files = (await o.get(`/api/groups/${g.id}/files`)).json; assert.equal(files.length, 1); assert.equal(files[0].username, 'bob'); assert.equal(files[0].name, 'notes.txt');
  const dl = await o.get(files[0].file_url, { raw: true }); assert.equal(dl.status, 200); assert.equal(await dl.text(), 'hello notes');
  const c = await o.post(`/api/posts/${post.json.id}/comments`, { content: 'thanks!' }); assert.equal(c.json.content, 'thanks!');
  assert.equal((await b.get(`/api/posts/${post.json.id}/comments`)).json[0].username, 'owner');
  assert.equal((await o.post(`/api/posts/${post.json.id}/react`, {})).json.reacted, true);
  const list = (await o.get(`/api/groups/${g.id}/posts`)).json; assert.equal(list[0].reaction_count, 1); assert.equal(list[0].comment_count, 1);
  assert.equal((await o.get(`/api/groups/${g.id}/members`)).json.length, 2);
  // group content stays out of the public ledger and feeds
  assert.equal(hub.db.get("SELECT COUNT(*) c FROM events WHERE body LIKE '%my notes%'").c, 0);
  assert.equal((await new Client(hub.base).get('/api/feed/public')).json.items.length, 0);
  assert.equal((await new Client(hub.base).get(`/api/groups/${g.id}/posts`)).status, 401);
  assert.equal((await b.post(`/api/groups/${g.id}/leave`, {})).json.success, true);
  assert.equal((await o.post(`/api/groups/${g.id}/leave`, {})).status, 409, 'last admin cannot leave');
  await hub.stop();
});
