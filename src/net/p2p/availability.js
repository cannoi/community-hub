'use strict';
const REQUIRED = [
  'libp2p', '@libp2p/websockets', '@libp2p/noise', '@libp2p/yamux',
  '@libp2p/identify', '@libp2p/ping', '@libp2p/peer-id', '@libp2p/crypto',
];
const DISCOVERY = ['@libp2p/kad-dht', '@libp2p/bootstrap'];
const NAT_RELAY = ['@libp2p/circuit-relay-v2', '@libp2p/dcutr', '@libp2p/autonat'];
const LAN = ['@libp2p/mdns'];
const PUBSUB = ['@libp2p/gossipsub'];

async function checkModules(importer = (n) => import(n), names = REQUIRED) {
  const missing = []; const errors = {};
  for (const n of names) {
    try { await importer(n); }
    catch (e) { missing.push(n); errors[n] = String(e && (e.code || e.message)).slice(0, 80); }
  }
  async function probe(list) {
    const miss = [];
    for (const n of list) { try { await importer(n); } catch { miss.push(n); } }
    return miss;
  }
  const discoveryMissing = await probe(DISCOVERY);
  const natRelayMissing = await probe(NAT_RELAY);
  const lanMissing = await probe(LAN);
  const pubsubMissing = await probe(PUBSUB);
  return {
    ok: missing.length === 0, missing, errors,
    discovery: discoveryMissing.length === 0, discoveryMissing,
    natRelay: natRelayMissing.length === 0, natRelayMissing,
    lan: lanMissing.length === 0, lanMissing,
    pubsub: pubsubMissing.length === 0, pubsubMissing,
  };
}
module.exports = { checkModules, REQUIRED, DISCOVERY, NAT_RELAY, LAN, PUBSUB };
