'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { localHttpCandidates, parsePublicIp } = require('../src/net/same-host');
const { httpEndpointFromMultiaddr } = require('../src/net/p2p/bootstrap/peer-crawl');

describe('federation endpoint from multiaddr + same-host', () => {
  it('derives http endpoint from public multiaddr', () => {
    const id = '12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS';
    const ep = httpEndpointFromMultiaddr(`/ip4/14.176.78.46/tcp/8182/ws/p2p/${id}`);
    assert.equal(ep, 'http://14.176.78.46:8182');
  });

  it('parses public IP from hub public URL', () => {
    assert.equal(parsePublicIp({ publicUrl: 'http://14.176.78.46:8181' }), '14.176.78.46');
  });

  it('local candidates for same public IP other port', () => {
    const cfg = { publicUrl: 'http://14.176.78.46:8182', publicIp: '14.176.78.46', p2p: { publicPort: 8182 } };
    const list = localHttpCandidates(cfg, 'http://14.176.78.46:8181');
    assert.ok(list.some((u) => u.includes('127.0.0.1:8181')));
    assert.ok(list.some((u) => u.includes('14.176.78.46:8181')));
  });
});
