'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function parseHostPort(ma) {
  const parts = String(ma || '').split('/').filter(Boolean);
  let host = null, port = null;
  for (let i = 0; i < parts.length; i++) {
    if ((parts[i] === 'ip4' || parts[i] === 'dns4') && parts[i + 1]) host = parts[i + 1];
    if (parts[i] === 'tcp' && parts[i + 1]) port = Number(parts[i + 1]);
  }
  return { host, port };
}

function decide(ma, pubIp, ownPort, selfPeerId) {
  if (selfPeerId && ma.includes('/p2p/' + selfPeerId)) return true;
  const { host, port } = parseHostPort(ma);
  if (pubIp && host === pubIp && port) {
    if (ownPort && port === ownPort) return true;
    const peerPart = (ma.match(/\/p2p\/[^/]+/) || [''])[0];
    return { rewrite: '/ip4/127.0.0.1/tcp/' + port + '/ws' + peerPart };
  }
  return false;
}

describe('same public IP different port', () => {
  it('rewrites peer on same IP other port to loopback', () => {
    const ma = '/ip4/14.176.78.46/tcp/8182/ws/p2p/12D3KooWOtherPeerXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const d = decide(ma, '14.176.78.46', 8181, '12D3KooWSelf');
    assert.ok(d.rewrite);
    assert.equal(d.rewrite, '/ip4/127.0.0.1/tcp/8182/ws/p2p/12D3KooWOtherPeerXXXXXXXXXXXXXXXXXXXXXXXXXX');
  });
  it('blocks exact self IP+port', () => {
    const ma = '/ip4/14.176.78.46/tcp/8181/ws/p2p/12D3KooWSelf';
    assert.equal(decide(ma, '14.176.78.46', 8181, '12D3KooWSelf'), true);
  });
  it('allows foreign IP unchanged', () => {
    const ma = '/ip4/4.149.245.81/tcp/8181/ws/p2p/12D3KooWForeign';
    assert.equal(decide(ma, '14.176.78.46', 8181, '12D3KooWSelf'), false);
  });
});
