#!/usr/bin/env node
'use strict';
// Verifies the WebSocket route from OUTSIDE (through SoloHost's reverse proxy / tunnel) to the Hub's P2P gateway.
//   node scripts/p2p-ws-probe.js wss://my.hub.example/      (or ws://host:port/p2p)
// Exit 0 = the upgrade reached the Hub's gateway AND its libp2p listener (101 + open). Prints a precise diagnosis otherwise.
const url = process.argv[2];
if (!url || !/^wss?:\/\//.test(url)) { console.error('usage: p2p-ws-probe.js <ws(s)://host[:port][/p2p]>'); process.exit(2); }
if (typeof WebSocket === 'undefined') { console.error('Node >= 22 required (global WebSocket)'); process.exit(2); }
const t0 = Date.now(); let done = false;
const finish = (code, msg) => { if (done) return; done = true; console.log(JSON.stringify({ ok: code === 0, ms: Date.now() - t0, url, result: msg })); setTimeout(() => process.exit(code), 50); };
const ws = new WebSocket(url);
const timer = setTimeout(() => finish(1, 'timeout: no answer in 8 s (proxy dropped the upgrade, firewall, or wrong port)'), 8000);
ws.onopen = () => { clearTimeout(timer); finish(0, 'OPEN: upgrade accepted end-to-end (gateway enabled, listener reachable)'); try { ws.close(); } catch { /* ignore */ } };
ws.onerror = () => { clearTimeout(timer); finish(1, 'refused: either P2P_ENABLED/P2P_WS_GATEWAY is off on the Hub, libp2p is not running, or the proxy does not pass "Upgrade"/"Connection: Upgrade" (nginx: proxy_set_header Upgrade $http_upgrade; proxy_http_version 1.1)'); };
