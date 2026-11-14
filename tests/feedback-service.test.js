'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createFeedbackService } = require('../lib/feedback-module/feedback-service');

test('Feedback Hub client uses verified API routes, server bearer auth and non-secret public config', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/api/client-policy')) return res.end(JSON.stringify({ donate: { enabled: false } }));
      if (req.url.startsWith('/api/notices?')) return res.end(JSON.stringify({ items: [{ id: 'notice-1' }] }));
      if (req.url === '/api/feedback') return res.end(JSON.stringify({ ok: true, id: 'feedback-1' }));
      if (req.url === '/api/notices/notice-1/read') return res.end(JSON.stringify({ ok: true }));
      res.statusCode = 404; res.end(JSON.stringify({ error: 'not_found' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const token = 'test-server-only-token';
  const fb = createFeedbackService({ hubId: 'hub-test', baseUrl: `http://127.0.0.1:${server.address().port}`, ingestToken: token, appId: 'community-hub', appName: 'Community Hub', version: '2.3.2' });
  try {
    const config = fb.publicConfig();
    assert.equal(config.hubId, 'hub-test');
    assert.ok(!JSON.stringify(config).includes(token));
    const synced = await fb.sync('anon-1');
    assert.equal(synced.notices[0].id, 'notice-1');
    assert.ok(seen.find((x) => x.url.startsWith('/api/client-policy')));
    assert.ok(seen.find((x) => x.url.startsWith('/api/notices?')));
    assert.deepEqual(await fb.send({ type: 'bug', message: 'test' }), { ok: true, id: 'feedback-1' });
    assert.equal(seen.find((x) => x.url === '/api/feedback').auth, `Bearer ${token}`);
    assert.equal(seen.find((x) => x.url === '/api/feedback').body.app_id, 'community-hub');
    assert.deepEqual(await fb.markRead('notice-1'), { ok: true });
    assert.equal(seen.find((x) => x.url === '/api/notices/notice-1/read').auth, `Bearer ${token}`);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
