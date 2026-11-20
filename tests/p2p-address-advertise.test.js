'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

describe('P2P advertise port policy', () => {
  it('does not invent port 8181 when publicPort unknown and URL has no port', () => {
    const cfg = loadConfig({
      HUB_PUBLIC_URL: '',
      PUBLIC_URL: '',
      PUBLIC_IP: '1.2.3.4',
      P2P_PUBLIC_PORT: '',
      HOST_PORT: '',
      P2P_WS_GATEWAY: 'true',
    });
    assert.equal(cfg.p2p.publicPort, 0);
    assert.ok(!cfg.publicUrl || !cfg.publicUrl.includes(':8181'));
  });

  it('uses explicit URL port 8182', () => {
    const cfg = loadConfig({
      HUB_PUBLIC_URL: 'http://14.176.78.46:8182',
      P2P_WS_GATEWAY: 'true',
    });
    assert.equal(cfg.p2p.publicPort, 8182);
  });

  it('uses P2P_PUBLIC_PORT when set', () => {
    const cfg = loadConfig({
      PUBLIC_IP: '14.176.78.46',
      P2P_PUBLIC_PORT: '8182',
      P2P_WS_GATEWAY: 'true',
    });
    assert.equal(cfg.p2p.publicPort, 8182);
    assert.equal(cfg.publicUrl, 'http://14.176.78.46:8182');
  });
});
