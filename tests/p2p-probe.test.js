'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { multiaddrToHttpBase, isPrivateIp } = require('../src/net/p2p/bootstrap/probe');

describe('P2P probe helpers', () => {
  it('parses multiaddr to http base', () => {
    const b = multiaddrToHttpBase('/ip4/14.176.78.46/tcp/8182/ws/p2p/12D3KooWabc');
    assert.equal(b, 'http://14.176.78.46:8182');
  });
  it('rejects private multiaddr host', () => {
    assert.equal(multiaddrToHttpBase('/ip4/192.168.1.5/tcp/8181/ws/p2p/12D3KooWabc'), null);
  });
  it('detects private ips', () => {
    assert.equal(isPrivateIp('10.0.0.1'), true);
    assert.equal(isPrivateIp('14.176.78.46'), false);
  });
});
