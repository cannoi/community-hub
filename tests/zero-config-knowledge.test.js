'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const defaults = require('../src/integrations/feedback-defaults');
const knowledge = require('../src/assistant-knowledge');
const A = require('../src/assistant');
const { startHub, Client } = require('./helpers');

test('CANNOI Feedback Hub defaults are built in and no user configuration is required', () => {
  assert.equal(defaults.hubId, 'SHFH-CANNOI-0905428801');
  assert.equal(defaults.baseUrl, 'http://14.176.78.46:8090');
  assert.equal(defaults.appId, 'community-hub');
  assert.equal(defaults.appName, 'Community Hub');
  assert.ok(defaults.ingestToken);
});

test('AI product knowledge includes current bootstrap and Feedback Hub facts but never the ingest token', () => {
  const k = knowledge.forAI({ lang: 'vi', version: '2.3.2' });
  assert.equal(k.release, '2.3.2');
  assert.equal(k.bootstrap.seedHttpUrl, 'http://14.176.78.46:28090');
  assert.equal(k.feedbackHub.hubId, defaults.hubId);
  assert.equal(k.feedbackHub.publicBaseUrl, defaults.baseUrl);
  const serialized = JSON.stringify(k) + knowledge.prompt('vi', '2.3.2');
  assert.ok(!serialized.includes(defaults.ingestToken));
  assert.match(serialized, /ZERO-CONFIGURATION/);
});

test('offline AI helper explains automatic bootstrap and preconfigured Feedback Hub in both languages', () => {
  const vi = A.localReply('Làm sao bootstrap và tự kết nối peer?', 'vi');
  const en = A.localReply('How does automatic bootstrap peer discovery work?', 'en');
  assert.match(vi, /tự động|tự động khám phá/i);
  assert.match(en, /automatic bootstrap/i);
  const fbVi = A.localReply('Feedback Hub cấu hình thế nào?', 'vi');
  const fbEn = A.localReply('How do I configure the Feedback Hub?', 'en');
  assert.match(fbVi, /không cần nhập/i);
  assert.match(fbEn, /No Hub ID.*needs to be entered/i);
});


test('public Feedback Hub config exposes metadata only and never the ingest credential', async () => {
  const hub = await startHub();
  try {
    const response = await new Client(hub.base).get('/api/feedback/config');
    assert.equal(response.status, 200);
    assert.equal(response.json.hubId, defaults.hubId);
    assert.equal(response.json.appId, 'community-hub');
    assert.ok(!response.text.includes(defaults.ingestToken));
    assert.ok(!response.text.includes('ingestToken'));
  } finally { await hub.stop(); }
});

test('AI Panel forwards canonical product knowledge to an OpenAI-compatible model', async () => {
  const http = require('node:http');
  let received = null;
  const model = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'Đã hiểu cấu hình Community Hub.' } }] }));
    });
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  const hub = await startHub({ ai: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'test-model', apiKey: 'test-ai-key', timeoutMs: 5000 } });
  try {
    const c = new Client(hub.base); await c.setup('owner');
    const response = await c.post('/api/ai/chat', { message: 'Giải thích cách tự bootstrap và Feedback Hub.' });
    assert.equal(response.status, 200);
    assert.equal(response.json.provider, 'custom');
    const system = received.messages[0].content;
    assert.match(system, /14\.176\.78\.46:28090/);
    assert.match(system, /SHFH-CANNOI-0905428801/);
    assert.ok(!system.includes(defaults.ingestToken));
    assert.match(system, /Vietnamese/);
  } finally {
    await hub.stop();
    await new Promise((resolve) => model.close(resolve));
  }
});
