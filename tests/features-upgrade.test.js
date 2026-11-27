'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHub, Client, formWith } = require('./helpers');

const hubs = [];
after(async () => {
  for (const h of hubs) {
    try { await h.stop(); } catch {}
  }
});

describe('Feature upgrades: Groups, P2P File Sharing, DM Attachments & Calls, Discovery, Sensitive Encryption, 7 Languages', () => {
  it('supports 7 popular languages across PATCH /api/me', async () => {
    const hub = await startHub({ allowRegistration: true, p2p: { enabled: false } });
    hubs.push(hub);
    const alice = new Client(hub.base);
    await alice.setup('alice', 'correct-horse-9');

    for (const lang of ['vi', 'zh', 'ja', 'ko', 'es', 'fr', 'en']) {
      const r = await alice.patch('/api/me', { lang });
      assert.equal(r.status, 200, `PATCH /api/me lang=${lang}`);
      assert.equal(r.json.user.lang, lang);
    }
    const bad = await alice.patch('/api/me', { lang: 'xx' });
    assert.equal(bad.status, 400);
  });

  it('encrypts sensitive meta (custom_seeds, intro_peer, public_url_override) at rest and masks public IP exposure', async () => {
    const hub = await startHub({ allowRegistration: true, allowPrivatePeers: false, p2p: { enabled: false } });
    hubs.push(hub);
    const alice = new Client(hub.base);
    await alice.setup('alice', 'correct-horse-9');

    const saveRes = await alice.post('/api/network/settings', {
      network_join: false,
      custom_seeds: 'https://203.0.113.45:8181, https://198.51.100.77:8181',
      intro_peer: 'https://203.0.113.45:8181',
      public_url_override: 'https://203.0.113.10:8181',
    });
    assert.equal(saveRes.status, 200);

    // Check raw DB rows: sensitive keys must be encrypted envelopes ({ __enc: 1, ... }), never plaintext IPs!
    const rawSeeds = hub.db.get("SELECT value FROM meta WHERE key='custom_seeds'")?.value || '';
    const rawIntro = hub.db.get("SELECT value FROM meta WHERE key='intro_peer'")?.value || '';
    const rawPub = hub.db.get("SELECT value FROM meta WHERE key='public_url_override'")?.value || '';
    assert.ok(rawSeeds.includes('"__enc":1'), 'custom_seeds should be AES-256-GCM encrypted in SQLite meta');
    assert.ok(!rawSeeds.includes('203.0.113.45'), 'custom_seeds ciphertext must not contain raw IP');
    assert.ok(rawIntro.includes('"__enc":1'), 'intro_peer should be encrypted in SQLite meta');
    assert.ok(!rawIntro.includes('203.0.113.45'));
    assert.ok(rawPub.includes('"__enc":1'), 'public_url_override should be encrypted in SQLite meta');
    assert.ok(!rawPub.includes('203.0.113.10'));

    // Authenticated owner reads masked / sanitized settings cleanly
    const readRes = await alice.get('/api/network/settings');
    assert.equal(readRes.status, 200);
    assert.ok(readRes.json.custom_seeds.includes('203.0.113.45'));
    assert.ok(readRes.json.masked_seeds.includes('•••.•••.•••.45'));

    const { maskEndpoint } = require('../src/net/sensitive-store');
    assert.equal(maskEndpoint('https://203.0.113.99:8181/p2p'), 'https://•••.•••.•••.99:8181/p2p');
    assert.equal(maskEndpoint('https://hub.example.org/test'), 'https://h•••b.e•••e.org');
  });

  it('supports full Group lifecycle: avatar, topic, search/discover, private invite code join, edit, pin post, delete', async () => {
    const hub = await startHub({ allowRegistration: true, p2p: { enabled: false } });
    hubs.push(hub);
    const alice = new Client(hub.base);
    await alice.setup('alice', 'correct-horse-9');
    const bob = new Client(hub.base);
    const bobReg = await bob.post('/api/register', { username: 'bob', password: 'correct-horse-9' });
    assert.equal(bobReg.status, 200);

    // Upload group avatar PNG (valid minimal 1x1 PNG)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const upRes = await alice.post('/api/media', null, { form: formWith(png, 'avatar.png') });
    assert.equal(upRes.status, 200);
    const avHash = upRes.json.hash;

    // Create private group with topic + avatar
    const createRes = await alice.post('/api/groups', {
      name: 'Rust P2P Builders',
      description: 'Decentralized systems & cryptography',
      topic: 'p2p-dev',
      visibility: 'private',
      avatar: avHash,
    });
    assert.equal(createRes.status, 200);
    const gid = createRes.json.id;
    assert.equal(createRes.json.topic, 'p2p-dev');
    assert.ok(createRes.json.invite_code);
    assert.equal(createRes.json.avatar_media, avHash);

    // Create open group for discovery search
    const openRes = await alice.post('/api/groups', { name: 'Photography Club', description: 'Film cameras', topic: 'photo', visibility: 'open' });
    assert.equal(openRes.status, 200);

    // Bob discovers open group via ?scope=discover&q=photo, and does not see private group yet
    const disc = await bob.get('/api/groups?scope=discover&q=photo');
    assert.equal(disc.status, 200);
    assert.equal(disc.json.length, 1);
    assert.equal(disc.json[0].name, 'Photography Club');

    // Bob joins private group via invite code
    const joinRes = await bob.post('/api/groups/join-code', { code: createRes.json.invite_code });
    assert.equal(joinRes.status, 200);
    assert.equal(joinRes.json.group_id, gid);
    assert.equal(joinRes.json.group.my_role, 'member');

    // Bob can fetch group avatar via signed URL or session cookie
    const avFetch = await bob.get(`/media/${avHash}`);
    assert.equal(avFetch.status, 200);

    // Alice posts in group and pins it
    const gp1 = await alice.post('/api/posts', { content: 'Welcome rule #1', group_id: gid });
    assert.equal(gp1.status, 201);
    const gp2 = await bob.post('/api/posts', { content: 'Second post in group', group_id: gid });
    assert.equal(gp2.status, 201);

    const patchRes = await alice.patch(`/api/groups/${gid}`, {
      name: 'Rust & Libp2p',
      pinned_post_id: gp1.json.post.id,
      rotate_invite: true,
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.json.name, 'Rust & Libp2p');
    assert.equal(patchRes.json.pinned_post_id, gp1.json.post.id);
    assert.notEqual(patchRes.json.invite_code, createRes.json.invite_code);

    // Pinned post appears first with is_group_pinned
    const postsRes = await bob.get(`/api/groups/${gid}/posts`);
    assert.equal(postsRes.status, 200);
    assert.equal(postsRes.json[0].id, gp1.json.post.id);
    assert.equal(postsRes.json[0].is_group_pinned, true);

    // Owner deletes group
    const delRes = await alice.delete(`/api/groups/${gid}`);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.json.deleted, true);
  });

  it('Secured P2P File Sharing enforces Ed25519 signature, SHA-256 check, scrypt passcode, download cap & revoke', async () => {
    const hub = await startHub({ allowRegistration: true, p2p: { enabled: false } });
    hubs.push(hub);
    const alice = new Client(hub.base);
    await alice.setup('alice', 'correct-horse-9');
    const bob = new Client(hub.base);
    const bobReg = await bob.post('/api/register', { username: 'bob', password: 'correct-horse-9' });
    assert.equal(bobReg.status, 200);

    const upRes = await alice.post('/api/media', null, { form: formWith(Buffer.from('Top secret P2P share payload 2026!'), 'secret-notes.txt') });
    assert.equal(upRes.status, 200);

    const createShare = await alice.post('/api/p2p/files', {
      media_hash: upRes.json.hash,
      name: 'secret-notes.txt',
      visibility: 'recipient',
      recipient: 'bob',
      passcode: 'pass1234',
      max_downloads: 1,
      expires_hours: 24,
      note: 'Verify integrity',
    });
    assert.equal(createShare.status, 201);
    const shareId = createShare.json.item.id;
    assert.equal(createShare.json.item.sig_valid, true);
    assert.equal(createShare.json.item.has_passcode, true);

    // Unrelated 3rd user cannot see recipient-only share
    const carol = new Client(hub.base);
    const carolReg = await carol.post('/api/register', { username: 'carol', password: 'correct-horse-9' });
    assert.equal(carolReg.status, 200);
    const carolGet = await carol.get(`/api/p2p/files/${shareId}`);
    assert.equal(carolGet.status, 404);

    // Wrong passcode rejected with 403 E_BAD_PASSCODE
    const badPw = await bob.post(`/api/p2p/files/${shareId}/download`, { passcode: 'wrongpw' });
    assert.equal(badPw.status, 403);
    assert.equal(badPw.json.code, 'E_BAD_PASSCODE');

    // Correct passcode downloads exact content & SHA-256 header
    const okDl = await fetch(`${hub.base}/api/p2p/files/${shareId}/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': bob.csrf,
        ...(bob.cookie ? { Cookie: bob.cookie } : {}),
        ...(bob.sessionToken ? { 'X-Hub-Session': bob.sessionToken } : {}),
      },
      body: JSON.stringify({ passcode: 'pass1234' }),
    });
    assert.equal(okDl.status, 200);
    assert.equal(okDl.headers.get('x-content-sha256'), upRes.json.hash);
    assert.equal(await okDl.text(), 'Top secret P2P share payload 2026!');

    // Second download hits max_downloads=1 -> 410 E_LIMIT_REACHED
    const limitDl = await bob.post(`/api/p2p/files/${shareId}/download`, { passcode: 'pass1234' });
    assert.equal(limitDl.status, 410);
    assert.equal(limitDl.json.code, 'E_LIMIT_REACHED');

    // Revoke
    const rev = await alice.delete(`/api/p2p/files/${shareId}`);
    assert.equal(rev.status, 200);
    const afterRev = await bob.get(`/api/p2p/files/${shareId}`);
    assert.equal(afterRev.status, 404);
  });

  it('E2EE DM attachments are authorized strictly for sender & recipient, and WebRTC signaling queues signals', async () => {
    const hub = await startHub({ allowRegistration: true, p2p: { enabled: false } });
    hubs.push(hub);
    const alice = new Client(hub.base);
    await alice.setup('alice', 'correct-horse-9');
    const bob = new Client(hub.base);
    assert.equal((await bob.post('/api/register', { username: 'bob', password: 'correct-horse-9' })).status, 200);
    const carol = new Client(hub.base);
    assert.equal((await carol.post('/api/register', { username: 'carol', password: 'correct-horse-9' })).status, 200);

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const upRes = await alice.post('/api/media', null, { form: formWith(png, 'pic.png') });
    assert.equal(upRes.status, 200);
    const hash = upRes.json.hash;

    const sendRes = await alice.post('/api/messages', {
      recipient: 'bob',
      content: 'Check this encrypted image',
      attachments: [hash],
    });
    assert.equal(sendRes.status, 201);

    const bobConv = await bob.get('/api/messages/alice');
    assert.equal(bobConv.status, 200);
    assert.equal(bobConv.json.messages.length, 1);
    assert.equal(bobConv.json.messages[0].content, 'Check this encrypted image');
    assert.equal(bobConv.json.messages[0].attachments.length, 1);
    assert.equal(bobConv.json.messages[0].attachments[0].hash, hash);

    // Bob can view DM media; Carol (unrelated 3rd party) receives 404
    const bobMedia = await bob.get(`/media/${hash}`);
    assert.equal(bobMedia.status, 200);
    const carolMedia = await carol.get(`/media/${hash}`);
    assert.equal(carolMedia.status, 404);

    // WebRTC call signaling
    const sigRes = await alice.post('/api/calls/signal', {
      to: 'bob',
      call_id: 'call-test-123',
      type: 'offer',
      data: { sdp: 'v=0', type: 'offer', video: true },
    });
    assert.equal(sigRes.status, 200);
    const bobPending = await bob.get('/api/calls/pending');
    assert.equal(bobPending.status, 200);
    assert.equal(bobPending.json.items.length, 1);
    assert.equal(bobPending.json.items[0].call_id, 'call-test-123');
    assert.equal(bobPending.json.items[0].video, true);
    assert.equal(bobPending.json.items[0].from_username, 'alice');
  });

  it('Discovery deduplicates repeated posts, penalizes spam, and personalizes via langs/tags', async () => {
    const hub = await startHub({ allowRegistration: true, p2p: { enabled: false } });
    hubs.push(hub);
    const alice = new Client(hub.base);
    await alice.setup('alice', 'correct-horse-9');
    const bob = new Client(hub.base);
    assert.equal((await bob.post('/api/register', { username: 'bob', password: 'correct-horse-9' })).status, 200);

    // Duplicate posts with identical normalized text should be deduped in /api/feed/foryou
    await alice.post('/api/posts', { content: 'Unique thoughtful story about decentralized P2P hubs #p2p', visibility: 'public' });
    await alice.post('/api/posts', { content: '  Unique thoughtful story about decentralized P2P hubs #p2p ', visibility: 'public' });
    // Spammy post with too many hashtags/repeats
    await alice.post('/api/posts', { content: 'buy #a #b #c #d #e #f #g #h #i #j now aaaaaaaaaaaaaa', visibility: 'public' });
    await bob.post('/api/posts', { content: 'Great photography hike this morning with #p2p friends', visibility: 'public' });

    const feed = await bob.get('/api/feed/foryou?langs=en&tags=p2p');
    assert.equal(feed.status, 200);
    const texts = feed.json.items.map((p) => p.content.trim());
    const dupCount = texts.filter((x) => x.startsWith('Unique thoughtful story')).length;
    assert.equal(dupCount, 1, 'identical posts should be deduplicated in discovery');
    assert.ok(!texts[0].includes('#j'), 'spam post should be demoted below legitimate posts');
  });
});
