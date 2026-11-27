'use strict';
/**
 * Extension interface for platform-specific transports (Wi-Fi Direct, Bluetooth).
 *
 * IMPORTANT: These are NOT implemented in the Node.js backend.
 * Native Android / iOS clients may plug in adapters that satisfy this interface.
 * Do not advertise Wi-Fi Direct or Bluetooth support until native integration
 * is complete and tested.
 *
 * @typedef {object} PlatformPeer
 * @property {string} id
 * @property {string} [name]
 * @property {string[]} [addresses]
 * @property {'wifi-direct'|'bluetooth'|'other'} transport
 *
 * @typedef {object} PlatformTransport
 * @property {() => string} kind          - 'wifi-direct' | 'bluetooth' | …
 * @property {() => boolean} isAvailable  - hardware + permission ready?
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {() => Promise<PlatformPeer[]>} discover
 * @property {(peer: PlatformPeer|string) => Promise<void>} connect
 * @property {(peerId: string) => Promise<void>} disconnect
 * @property {(peerId: string, data: Uint8Array) => Promise<void>} send
 * @property {(handler: (from: string, data: Uint8Array) => void) => () => void} onMessage
 */

/** Null implementation — always reports unavailable. */
function createNullPlatformTransport(kind = 'none') {
  return {
    kind: () => kind,
    isAvailable: () => false,
    async start() {},
    async stop() {},
    async discover() { return []; },
    async connect() {
      const e = new Error(kind + ' transport is not implemented on this platform');
      e.code = 'E_PLATFORM_TRANSPORT_UNAVAILABLE';
      throw e;
    },
    async disconnect() {},
    async send() {
      const e = new Error(kind + ' transport is not implemented on this platform');
      e.code = 'E_PLATFORM_TRANSPORT_UNAVAILABLE';
      throw e;
    },
    onMessage() { return () => {}; },
  };
}

module.exports = {
  createNullPlatformTransport,
  // Future: createWifiDirectTransport, createBluetoothTransport (native only)
};
