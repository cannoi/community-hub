'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startHub, Client } = require('./helpers');

test('Logs endpoints work cleanly for owner and non-owner receives 403', async () => {
  const hub = await startHub({
    allowRegistration: true,
    p2p: { enabled: false },
    rateLimit: { general: 5000, write: 5000, login: 500, upload: 500, federation: 500, assistant: 50 },
  });
  try {
    const owner = new Client(hub.base);
    await owner.setup('owner1');
    const member = new Client(hub.base);
    await member.post('/api/register', { username: 'member1', password: 'password123' });

    const r1 = await owner.get('/api/ai/logs');
    assert.equal(r1.status, 200);
    assert.ok(Array.isArray(r1.json.logs));
    assert.ok(Array.isArray(r1.json.network));
    assert.ok(Array.isArray(r1.json.ai));

    const r2 = await owner.get('/api/logs');
    assert.equal(r2.status, 200);
    assert.ok(Array.isArray(r2.json.logs));

    const del = await owner.del('/api/ai/logs');
    assert.equal(del.status, 200);
    assert.equal(del.json.ok, true);

    const deny = await member.get('/api/ai/logs');
    assert.equal(deny.status, 403);
  } finally {
    await hub.stop();
  }
});

test('DM supports same-hub delivery, cross-hub key lookup + delivery, and P2P peer id resolution', async () => {
  const hubA = await startHub({
    allowRegistration: true,
    allowPrivatePeers: true,
    p2p: { enabled: false },
    rateLimit: { general: 5000, write: 5000, login: 500, upload: 500, federation: 500, assistant: 50 },
  });
  const hubB = await startHub({
    allowRegistration: true,
    allowPrivatePeers: true,
    p2p: { enabled: false },
    rateLimit: { general: 5000, write: 5000, login: 500, upload: 500, federation: 500, assistant: 50 },
  });
  try {
    const alice = new Client(hubA.base);
    await alice.setup('alice');
    const charlie = new Client(hubA.base);
    await charlie.post('/api/register', { username: 'charlie', password: 'password123' });
    const charlieInfo = (await charlie.get('/api/me')).json.user;

    // 1) Same-Hub DM
    const convLocal = await alice.get('/api/messages/' + encodeURIComponent(charlieInfo.account_id));
    assert.equal(convLocal.status, 200);
    assert.equal(convLocal.json.peer.has_key, true);

    const sentLocal = await alice.post('/api/messages', { recipient: charlieInfo.account_id, content: 'Hello locally!' });
    assert.equal(sentLocal.status, 201);
    assert.equal(sentLocal.json.status, 'delivered');

    const bob = new Client(hubB.base);
    await bob.setup('bob');
    const bobInfo = (await bob.get('/api/me')).json.user;

    // 2) Cross-Hub DM: register Hub B as healthy peer of Hub A, seed remote user without dm_pub
    const peer = hubA.peers.add(hubB.base, { state: 'trusted', name: 'Hub B' });
    hubA.db.run('UPDATE peers SET account_id=?, last_ok=? WHERE id=?', bobInfo.account_id, Date.now(), peer.id);
    hubA.db.run(
      `INSERT OR REPLACE INTO users(username, account_id, pubkey, status, dm_pub, created_at)
       VALUES(?, ?, ?, 'remote', NULL, CURRENT_TIMESTAMP)`,
      'r_bob', bobInfo.account_id, hubB.ks.publicKey(bobInfo.account_id)
    );

    const convRemote = await alice.get('/api/messages/' + encodeURIComponent(bobInfo.account_id));
    assert.equal(convRemote.status, 200);
    assert.equal(convRemote.json.peer.has_key, true, 'conversation() should resolve remote dm_pub');

    const sentRemote = await alice.post('/api/messages', { recipient: bobInfo.account_id, content: 'Encrypted hello across Hubs!' });
    assert.equal(sentRemote.status, 201);
    assert.equal(sentRemote.json.status, 'delivered');

    const aliceInfo = (await alice.get('/api/me')).json.user;
    const bobInbox = await bob.get('/api/messages/' + encodeURIComponent(aliceInfo.account_id));
    assert.equal(bobInbox.status, 200);
    assert.equal(bobInbox.json.messages.length, 1);
    assert.equal(bobInbox.json.messages[0].content, 'Encrypted hello across Hubs!');

    // 3) _p2pPeerIdFor ignores hub1_... pins and resolves real peer_id from p2p_peer_registry
    const fakeLibp2pId = '12D3KooWTestPeer111111111111111111111111111111111111';
    hubA.db.run(
      'INSERT OR REPLACE INTO p2p_peer_registry(peer_id, record, expires_at, updated_at) VALUES(?,?,?,?)',
      fakeLibp2pId,
      JSON.stringify({ account_id: bobInfo.account_id, endpoint: hubB.base }),
      Date.now() + 60000,
      Date.now()
    );
    assert.equal(hubA.dm._p2pPeerIdFor({ pin: bobInfo.account_id, endpoint: hubB.base }, bobInfo.account_id), fakeLibp2pId);
    assert.equal(hubA.dm._p2pPeerIdFor({ pin: 'hub1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, 'hub1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), null);

    // 4) Remote account without key returns 409 E_DM_NO_KEY
    const noKeyAcct = 'hub1_' + 'a'.repeat(52);
    hubA.db.run(
      `INSERT OR REPLACE INTO users(username, account_id, status, dm_pub, created_at)
       VALUES('nokey_remote', ?, 'remote', NULL, CURRENT_TIMESTAMP)`,
      noKeyAcct
    );
    const failSend = await alice.post('/api/messages', { recipient: noKeyAcct, content: 'Should fail cleanly' });
    assert.equal(failSend.status, 409);
    assert.equal(failSend.json.code, 'E_DM_NO_KEY');
  } finally {
    await hubA.stop();
    await hubB.stop();
  }
});

test('Frontend fixes: in-app back navigation, DM key guidance, logs handler, and i18n keys exist', () => {
  const views = fs.readFileSync(path.join(__dirname, '..', 'public', 'views.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8');

  // Back button uses explicit in-app navStack + goBack instead of history.back()
  assert.ok(!views.includes('history.back()'), 'top() should not rely on window.history.back()');
  assert.ok(views.includes('goBack()') && views.includes('navStack'), 'views.js should maintain explicit in-app navStack');
  assert.ok(views.includes("type: 'button'") && views.includes("aria-label': t('back')"), 'back button should have type=button');

  // DM UI disables compose when recipient lacks key and provides checkKey action
  assert.ok(views.includes("t('messages.noKeyHelp')") && views.includes("t('messages.checkKey')"));
  assert.ok(views.includes("?refresh=1"));

  // Logs tab uses loadLogs helper and renders errors cleanly
  assert.ok(views.includes('loadLogs(') && views.includes('errText(e)'));

  // i18n error codes and DM key messages present in both languages
  for (const key of ['err.E_DM_NO_KEY', 'err.E_BLOCKED', 'messages.noKeyHelp', 'messages.checkKey']) {
    const matches = i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || [];
    assert.equal(matches.length, 2, `Missing en/vi translation for ${key}`);
  }
});
