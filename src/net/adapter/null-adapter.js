'use strict';
const { NetworkAdapter } = require('./interface');

/** No-op adapter used when networking features are intentionally disabled. */
class NullAdapter extends NetworkAdapter {
  kind() { return 'null'; }
  isEnabled() { return false; }
  async start() {}
  async stop() {}
  status() {
    return { kind: 'null', enabled: false, peers: 0, state: 'disabled' };
  }
}

module.exports = { NullAdapter };
