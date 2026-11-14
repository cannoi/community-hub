'use strict';
/**
 * Shared types / constants for CANNOI auto-bootstrap.
 *
 * Two node categories (never mix):
 *   infrastructure — helps discovery/relay; not CANNOI members
 *   cannoi         — verified Community Hub peers
 */

const NETWORK_ID = 'cannoi';
const PROTOCOL_VERSION = '1.0.0';
const PEER_RECORD_PROTOCOL = '/cannoi/peer-record/1.0.0';
const PEER_EXCHANGE_PROTOCOL = '/cannoi/peer-exchange/1.0.0';

/** Onboarding / bootstrap lifecycle states (honest). */
const BOOTSTRAP_STATES = Object.freeze({
  NETWORK_INITIALIZING: 'NETWORK_INITIALIZING',
  WAITING_FOR_FIRST_PEER: 'WAITING_FOR_FIRST_PEER',
  BOOTSTRAP_CONNECTED: 'BOOTSTRAP_CONNECTED',
  PUBLICLY_DISCOVERABLE: 'PUBLICLY_DISCOVERABLE',
  RELAY_AVAILABLE: 'RELAY_AVAILABLE',
  NETWORK_JOINED: 'NETWORK_JOINED',
});

/** Provider kinds. */
const PROVIDER_KINDS = Object.freeze({
  FIXED: 'fixed',
  KNOWN: 'known',
  LIBP2P: 'libp2p',
  HTTPS_MANIFEST: 'https_manifest',
  DNS: 'dns',
  REGISTRY: 'registry',
  MDNS: 'mdns',
  EXCHANGE: 'exchange',
});

/**
 * @typedef {object} PeerCandidate
 * @property {string} peerId
 * @property {string[]} multiaddrs
 * @property {'infrastructure'|'cannoi'} category
 * @property {string} source          - provider kind
 * @property {string} [protocol]
 * @property {string[]} [capabilities]
 * @property {number} [expiresAt]
 * @property {string} [signature]
 * @property {number} [lastSeen]
 * @property {number} [score]
 */

/**
 * @typedef {object} BootstrapProvider
 * @property {() => string} kind
 * @property {() => string} name
 * @property {() => boolean} isEnabled
 * @property {() => Promise<PeerCandidate[]>} discover
 * @property {() => object} status
 */

module.exports = {
  NETWORK_ID,
  PROTOCOL_VERSION,
  PEER_RECORD_PROTOCOL,
  PEER_EXCHANGE_PROTOCOL,
  BOOTSTRAP_STATES,
  PROVIDER_KINDS,
};
