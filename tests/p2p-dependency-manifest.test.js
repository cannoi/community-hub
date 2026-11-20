'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
test('P2P GossipSub dependency is pinned to a published compatible release', () => {
  assert.equal(pkg.dependencies['@libp2p/gossipsub'], '17.2.1');
  assert.match(fs.readFileSync(path.join(root, 'src/net/p2p/availability.js'), 'utf8'), /@libp2p\/gossipsub/);
  assert.match(fs.readFileSync(path.join(root, 'src/net/p2p/libp2p-adapter.js'), 'utf8'), /import\('@libp2p\/gossipsub'\)/);
});
test('Docker build verifies the GossipSub runtime export', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /import\('@libp2p\/gossipsub'\)/);
  assert.match(dockerfile, /GossipSub module OK/);
});
