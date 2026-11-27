'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDiscoveryDetail, peerIdFromAddr, multiaddrString } = require('../src/net/p2p/peer-info');

describe('peer discovery normalize (mDNS / multiaddr shapes)', () => {
  it('handles string multiaddrs', () => {
    const n = normalizeDiscoveryDetail({
      id: '12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS',
      multiaddrs: ['/ip4/127.0.0.1/tcp/4001/ws/p2p/12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS'],
    });
    assert.ok(n);
    assert.equal(n.multiaddrs.length, 1);
  });

  it('handles Multiaddr-like objects without getPeerId', () => {
    const fake = { toString: () => '/ip4/10.0.0.2/tcp/4001/ws/p2p/12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS' };
    const n = normalizeDiscoveryDetail({ id: { toString: () => '12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS' }, multiaddrs: [fake] });
    assert.equal(n.id.startsWith('12D3'), true);
    assert.ok(n.multiaddrs[0].includes('10.0.0.2'));
  });

  it('never throws when getPeerId is missing on addr', () => {
    assert.equal(peerIdFromAddr('/ip4/1.2.3.4/tcp/1/ws'), null);
    assert.equal(peerIdFromAddr({ toString: () => '/ip4/1.2.3.4/tcp/1/ws/p2p/12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS' }).startsWith('12D3'), true);
    assert.equal(peerIdFromAddr(null), null);
    assert.equal(multiaddrString('not-an-addr'), null);
  });

  it('handles object with getPeerId method', () => {
    const addr = {
      getPeerId: () => '12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS',
      toString: () => '/ip4/1.2.3.4/tcp/9/ws/p2p/12D3KooWQAKEWN9WQ1zXS6J5x7ChQG8Ndpu6o6UyoSBwPxWeGRDS',
    };
    assert.equal(peerIdFromAddr(addr).startsWith('12D3'), true);
  });

  it('returns null for empty detail', () => {
    assert.equal(normalizeDiscoveryDetail(null), null);
    assert.equal(normalizeDiscoveryDetail({}), null);
  });
});
