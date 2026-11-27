'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { RegionalDirectory, hashShard } = require('../src/net/p2p/bootstrap/directory');

describe('Phase 4 Regional Directory', () => {
  it('shards peer ids stably', () => {
    const a = hashShard('12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 16);
    const b = hashShard('12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 16);
    assert.equal(a, b);
    assert.ok(a >= 0 && a < 16);
  });

  it('paginates and biases region without excluding others', () => {
    const d = new RegionalDirectory({ shards: 8 });
    d.put({
      peer_id: '12D3KooWVNPeerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      multiaddrs: ['/ip4/1.1.1.1/tcp/8181/ws/p2p/12D3KooWVNPeerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'],
      region: 'VN', languages: ['vi'], verified: true, expires_at: Date.now() + 3600000,
    });
    d.put({
      peer_id: '12D3KooWJPPeerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      multiaddrs: ['/ip4/2.2.2.2/tcp/8181/ws/p2p/12D3KooWJPPeerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'],
      region: 'JP', languages: ['ja'], verified: true, expires_at: Date.now() + 3600000,
    });
    const q = d.query({ region: 'VN', language: 'vi', limit: 10 });
    assert.ok(q.items.length >= 2);
    assert.equal(q.items[0].region, 'VN');
    assert.ok(q.items.some((x) => x.region === 'JP'));
  });

  it('incremental cursor returns only newer seq', () => {
    const d = new RegionalDirectory();
    d.put({ peer_id: '12D3KooWA1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', multiaddrs: ['/ip4/1.1.1.1/tcp/1/ws/p2p/12D3KooWA1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'], expires_at: Date.now() + 1e7 });
    const first = d.query({ limit: 10 });
    const cur = first.next_cursor;
    d.put({ peer_id: '12D3KooWA2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', multiaddrs: ['/ip4/1.1.1.1/tcp/2/ws/p2p/12D3KooWA2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'], expires_at: Date.now() + 1e7 });
    const second = d.query({ cursor: cur, limit: 10 });
    assert.ok(second.items.every((x) => x.seq > cur));
    assert.ok(second.items.some((x) => x.peer_id.startsWith('12D3KooWA2')));
  });

  it('identity is peer_id not IP — same peer keeps id after endpoint change', () => {
    const d = new RegionalDirectory();
    const id = '12D3KooWSamePeerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    d.put({ peer_id: id, multiaddrs: ['/ip4/1.1.1.1/tcp/8181/ws/p2p/' + id], region: 'VN', expires_at: Date.now() + 1e7 });
    d.put({ peer_id: id, multiaddrs: ['/ip4/9.9.9.9/tcp/8182/ws/p2p/' + id], region: 'VN', expires_at: Date.now() + 1e7 });
    const q = d.query({ limit: 20 });
    const matches = q.items.filter((x) => x.peer_id === id);
    assert.equal(matches.length, 1);
    assert.ok(matches[0].multiaddrs[0].includes('9.9.9.9'));
  });
});
