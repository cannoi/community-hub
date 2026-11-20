'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('Docker image enables P2P, existing-port WebSocket gateway and bounded directory by default', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /P2P_ENABLED=true/);
  assert.match(dockerfile, /P2P_WS_GATEWAY=true/);
  assert.doesNotMatch(dockerfile, /P2P_PUBLIC_PORT=8181/, 'image must not override the per-Hub public port from HUB_PUBLIC_URL/HOST_PORT');
  assert.match(dockerfile, /PRESENCE_SERVE=true/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /EXPOSE 8080/);
});

test('Compose separates this Hub public URL from the shared rendezvous seed', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /HUB_PUBLIC_URL=\$\{HUB_PUBLIC_URL:-\}/);
  assert.match(compose, /PUBLIC_URL=\$\{PUBLIC_URL:-\}/);
  assert.doesNotMatch(compose, /HUB_PUBLIC_URL=\$\{HUB_PUBLIC_URL:-http:\/\/14\.176\.78\.46:8181\}/);
  assert.match(compose, /PRESENCE_SEEDS=\$\{PRESENCE_SEEDS:-http:\/\/14\.176\.78\.46:8181\}/);
  assert.match(compose, /P2P_FIXED_SEEDS=\$\{P2P_FIXED_SEEDS:-http:\/\/14\.176\.78\.46:8181\}/);
  assert.match(compose, /PRESENCE_SERVE=\$\{PRESENCE_SERVE:-true\}/);
  assert.match(compose, /P2P_ENABLED=\$\{P2P_ENABLED:-true\}/);
  assert.match(compose, /P2P_WS_GATEWAY=\$\{P2P_WS_GATEWAY:-true\}/);
  assert.match(compose, /\$\{HOST_PORT:-8181\}:8080/);
  assert.match(compose, /P2P_PEER_CRAWL=\$\{P2P_PEER_CRAWL:-true\}/);
  assert.match(compose, /P2P_CRAWL_PER_CYCLE=\$\{P2P_CRAWL_PER_CYCLE:-4\}/);
  assert.match(compose, /P2P_MIN_PEERS=\$\{P2P_MIN_PEERS:-3\}/);
});
