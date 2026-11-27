# PHASE 4 — Independent LAN discovery and offline messaging

**Date:** 2026-11-13  
**Status:** COMPLETE  
**Depends on:** Phase 0–3

---

## 1. What was implemented

### mDNS local discovery
- `@libp2p/mdns` integrated into `peerDiscovery` when available
- **Independent of Internet, DHT, and bootstrap** — works when all external seeds are offline
- Configurable interval (`P2P_MDNS_INTERVAL_MS`) and service tag (`P2P_MDNS_SERVICE_TAG`)
- Private/link-local addresses automatically classified as LAN source

### LAN peer registry (`src/net/p2p/lan-registry.js`)
- Tracks peers with source tags: `mdns | lan | dht | bootstrap | relay | manual`
- TTL-based expiry, bounded size
- `listLan()` returns only local-network peers
- Used by adapter for `listLanPeers()` and status `lan_peers`

### Local messaging (`src/net/p2p/local-messaging.js`)
- Protocol `/cannoi/msg/1.0.0` over libp2p streams
- Immediate delivery when peer is connected
- **In-memory queue** when peer unreachable (Phase 5 will make this persistent)
- `sendLocalMessage`, `onLocalMessage`, `flushLocalMessages`, `pendingLocalMessages`
- Health loop flushes pending messages when peers reconnect

### Platform transport extension (`src/net/p2p/platform-transport.js`)
- Interface for Wi-Fi Direct and Bluetooth
- **Null implementations only** — `isAvailable()` always false on Node.js backend
- Documented: do not advertise native support until native clients integrate and test
- Isolated from Node.js backend; future Android/iOS adapters can plug in

### Automatic private-peer allowance
- When mDNS is enabled or `P2P_LAN_ONLY=true`, private addresses are dialable
- Enables pure LAN operation without public IPs

---

## 2. Config additions

| Env | Default | Meaning |
|-----|---------|---------|
| `P2P_MDNS` | true | Enable mDNS LAN discovery |
| `P2P_MDNS_INTERVAL_MS` | 20000 | mDNS query interval |
| `P2P_MDNS_SERVICE_TAG` | `_cannoi-hub._udp.local` | Service tag |
| `P2P_LAN_ONLY` | false | Force private-peer mode |

---

## 3. status() new fields

```
lan_peers, mdns, pending_local_messages
```

---

## 4. Files added / changed

| File | Role |
|------|------|
| `src/net/p2p/lan-registry.js` | **New** — LAN peer registry |
| `src/net/p2p/local-messaging.js` | **New** — stream messaging + in-memory queue |
| `src/net/p2p/platform-transport.js` | **New** — Wi-Fi Direct / BT extension interface |
| `src/net/p2p/libp2p-adapter.js` | mDNS, LAN registry, local messaging wiring |
| `src/net/p2p/availability.js` | LAN package group |
| `src/config.js` | mDNS / LAN options |
| `package.json` | `@libp2p/mdns` |
| `tests/p2p-lan.test.js` | **New** — 10 tests |

---

## 5. Test results

```
tests/p2p-lan.test.js         10/10 pass
tests/p2p-nat-relay.test.js    8/8 pass
```

---

## 6. Explicit limitations

- Wi-Fi Direct / Bluetooth: **interface only**, not implemented
- Local message queue is **in-memory** — survives process only until Phase 5
- mDNS requires multicast-capable network (typical home/office LAN; may fail on some restricted VLANs)

---

## 7. Ready for Phase 5

**PHASE 5 — Store-and-Forward and persistent message delivery**
