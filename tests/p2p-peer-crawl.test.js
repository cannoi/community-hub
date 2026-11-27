'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PeerCrawler, httpEndpointFromMultiaddr, endpointForPeer } = require('../src/net/p2p/bootstrap/peer-crawl');
const { PeerDatabase } = require('../src/net/p2p/bootstrap/peer-db');
const { BootstrapManager } = require('../src/net/p2p/bootstrap/manager');
const { createPeerRecord } = require('../src/net/p2p/bootstrap/peer-record');

const A='12D3KooWH3DZFYdzteTwq5ztiiQ9x7Nt7WgFe';
const B='12D3KooWH3DZFYdzteTwq5ztiiQ9x7Nt7WgFf';
const C='12D3KooWH3DZFYdzteTwq5ztiiQ9x7Nt7WgFg';
const ma=id=>`/ip4/8.8.8.8/tcp/8181/ws/p2p/${id}`;

test('derive HTTP endpoint from public WS multiaddr on shared port',()=>{
 assert.equal(httpEndpointFromMultiaddr(ma(A)),'http://8.8.8.8:8181');
 assert.equal(endpointForPeer({multiaddrs:[`/ip4/192.168.1.2/tcp/8181/ws/p2p/${A}`,ma(A)]}),'http://8.8.8.8:8181');
 assert.equal(httpEndpointFromMultiaddr(`/ip4/192.168.1.2/tcp/8181/ws/p2p/${A}`),null);
});
test('crawl peers through a Hub and persist discovered public peers',async()=>{
 const db=new PeerDatabase(); db.upsert({peerId:A,multiaddrs:[ma(A)],category:'cannoi'});
 let called=0;
 const crawler=new PeerCrawler({peerDb:db,fetchJson:async url=>{called++;assert.equal(url,'http://8.8.8.8:8181/p2p/bootstrap');return {network:'cannoi',peers:[{peer_id:B,multiaddrs:[ma(B)]}]};}});
 const found=await crawler.crawl();
 assert.equal(called,1); assert.equal(found.length,1); assert.ok(db.get(B));
});
test('crawl obeys per-cycle cap and prioritizes connected bridge peers',async()=>{
 const db=new PeerDatabase();
 db.upsert({peerId:A,multiaddrs:[ma(A)],category:'cannoi'});
 db.upsert({peerId:B,multiaddrs:[`/ip4/9.9.9.9/tcp/8181/ws/p2p/${B}`],category:'cannoi'});
 db.upsert({peerId:C,multiaddrs:[`/ip4/1.1.1.1/tcp/8181/ws/p2p/${C}`],category:'cannoi'});
 const asked=[];
 const crawler=new PeerCrawler({peerDb:db,perCycle:2,getConnectedPeerIds:()=>[A],fetchJson:async url=>{asked.push(url);return {network:'cannoi',peers:[]};}});
 // A was queried more recently than B/C, but live connectivity wins as bridge priority.
 crawler._lastAsked.set(A, Date.now());
 await crawler.crawl(); assert.equal(asked.length,2);
 assert.equal(asked[0], 'http://8.8.8.8:8181/p2p/bootstrap', 'connected Hub A is crawled first as a bridge');
});
test('failed crawl uses exponential backoff',async()=>{
 const db=new PeerDatabase(); db.upsert({peerId:A,multiaddrs:[ma(A)],category:'cannoi'});
 let calls=0; const crawler=new PeerCrawler({peerDb:db,fetchJson:async()=>{calls++;throw Error('offline');}});
 await crawler.crawl(); await crawler.crawl(); assert.equal(calls,1);
});

test('acceptExchange rejects LAN addresses and accepts public peer addresses',()=>{
 const manager=new BootstrapManager({cfg:{fixedSeeds:[]}});
 const privateRecord=createPeerRecord({peerId:B,multiaddrs:[`/ip4/192.168.1.8/tcp/8181/ws/p2p/${B}`],reachability:'public'});
 const publicRecord=createPeerRecord({peerId:C,multiaddrs:[ma(C)],reachability:'public'});
 assert.equal(manager.acceptExchange([privateRecord]).accepted,0);
 assert.equal(manager.acceptExchange([publicRecord]).accepted,1);
});

test('crawl skips this Hub own record even when it is present in the peer database',async()=>{
 const db=new PeerDatabase(); db.upsert({peerId:A,multiaddrs:[ma(A)],category:'cannoi'});
 let calls=0;
 const crawler=new PeerCrawler({peerDb:db,getPeerId:()=>A,fetchJson:async()=>{calls++;return {network:'cannoi',peers:[]};}});
 await crawler.crawl(); assert.equal(calls,0);
});

test('local public gateway record is published even when loopback AutoNAT reports private',async()=>{
 const published=[];
 const manager=new BootstrapManager({
  cfg:{fixedSeeds:['http://8.8.4.4:8181','http://8.8.4.5:8181'],peerCrawl:false},
  getPeerId:()=>A,
  getMultiaddrs:()=>[`/ip4/14.176.78.46/tcp/8182/ws/p2p/${A}`],
  getReachability:()=> 'private',
  publishPeerRecord:async(url,record)=>{published.push({url,record});return {ok:true};},
 });
 manager._running=true;
 manager.peerDb.upsert({peerId:B,multiaddrs:[`/ip4/9.9.9.9/tcp/8181/ws/p2p/${B}`],category:'cannoi'});
 manager.peerDb.upsert({peerId:C,multiaddrs:[`/ip4/1.1.1.1/tcp/8181/ws/p2p/${C}`],category:'cannoi'});
 await manager.runCycle();
 await manager.stop();
 assert.equal(published.length,4); // two configured seeds + two known Hubs
 assert.ok(published.every(x=>x.record.multiaddrs.includes(`/ip4/14.176.78.46/tcp/8182/ws/p2p/${A}`)));
 assert.ok(published.every(x=>x.url!=='http://14.176.78.46:8182'));
 assert.ok(manager.status().last_registration_at, 'registration timestamp is set only after a successful remote publish');
});
