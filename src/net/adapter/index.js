'use strict';
const { NetworkAdapter } = require('./interface');
const { HttpsAdapter } = require('./https-adapter');
const { NullAdapter } = require('./null-adapter');

/**
 * Create the active network adapter.
 *
 * Selection rules (Phase 2):
 *  - P2P_ENABLED=true AND libp2p adapter loadable → Libp2pAdapter
 *  - federationEnabled=false AND p2p disabled → NullAdapter
 *  - otherwise → HttpsAdapter (default)
 */
function createNetworkAdapter(hubLike) {
  const cfg = hubLike.cfg || {};
  const p2pOn = !!(cfg.p2p && cfg.p2p.enabled);

  if (p2pOn) {
    try {
      const { Libp2pAdapter } = require('../p2p/libp2p-adapter');
      return new Libp2pAdapter({
        cfg,
        log: hubLike.log,
        keyDir: cfg.keyDir,
      });
    } catch (e) {
      if (hubLike.log) {
        hubLike.log.warn('p2p enabled but adapter failed to load (' + e.message + '); falling back to HTTPS');
      }
    }
  }

  if (cfg.p2p && cfg.p2p.enabled === false && cfg.federationEnabled === false) {
    return new NullAdapter();
  }

  return new HttpsAdapter({
    peers: hubLike.peers,
    transport: hubLike.transport,
    log: hubLike.log,
  });
}

module.exports = {
  NetworkAdapter,
  HttpsAdapter,
  NullAdapter,
  createNetworkAdapter,
};
