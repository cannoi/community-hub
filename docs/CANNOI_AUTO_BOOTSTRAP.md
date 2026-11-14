# CANNOI Auto Bootstrap & Self-Registering Peer Network

**Date:** 2026-11-14  
**Baseline:** Community Hub 2.3.0 Resilient Network

## Problem solved

A newly installed Hub must join the CANNOI network without the operator knowing any Peer ID, IP, or multiaddr — and without a mandatory VPS.

## Multi-source discovery (priority)

1. Previously known peer database (persistent)
2. Built-in fixed seed rendezvous endpoint (`http://14.176.78.46:28090` in the supplied SoloHost deployment)
3. libp2p bootstrap multiaddrs (`P2P_BOOTSTRAP`)
4. HTTPS signed seed manifests (`P2P_HTTPS_SEED_MANIFESTS`)
5. Optional DNS seeds (`P2P_DNS_SEEDS`)
6. LAN mDNS
7. Peer exchange from connected CANNOI peers

No single source is mandatory. Failures are isolated.

## Node categories (never mixed)

| Category | Meaning |
|----------|---------|
| `infrastructure` | DHT/relay/bootstrap helpers — not CANNOI members |
| `cannoi` | Verified Community Hub peers |

## Honest onboarding states

| State | Meaning |
|-------|---------|
| `NETWORK_INITIALIZING` | Starting |
| `WAITING_FOR_FIRST_PEER` | No CANNOI peer connected yet |
| `BOOTSTRAP_CONNECTED` | Linked to infrastructure bootstrap |
| `PUBLICLY_DISCOVERABLE` | Public reachability + published record |
| `RELAY_AVAILABLE` | Relay path available |
| `NETWORK_JOINED` | **Real authenticated CANNOI peer connected** |

`NETWORK_JOINED` is never reported until a real CANNOI peer connection exists.

## First node on one computer

1. Generate persistent Peer Identity
2. Load empty peer DB → state `WAITING_FOR_FIRST_PEER`
3. Fixed seed requests `/p2p/bootstrap` from your public Hub (`http://14.176.78.46:28090`) and obtains its current Peer ID + WebSocket multiaddr
4. LAN mDNS works for same-network instances
5. When a second Hub connects and authenticates → `NETWORK_JOINED`

One computer can initialize and test the first node. Multi-peer connectivity needs a second instance (container or machine).

## Config

| Env | Default | Purpose |
|-----|---------|---------|
| `P2P_FIXED_SEEDS` | `http://14.176.78.46:28090` | HTTP rendezvous endpoints; each returns `/p2p/bootstrap` descriptor |
| `P2P_HTTPS_SEED_MANIFESTS` | — | Signed JSON manifest URLs |
| `P2P_DNS_SEEDS` | — | DNS TXT seed domains |
| `P2P_BOOTSTRAP` | — | libp2p multiaddrs |
| `P2P_BOOTSTRAP_INTERVAL_MS` | 30000 | Discovery cycle |

## Modules

```
src/net/p2p/bootstrap/
  types.js          constants + states
  peer-db.js        persistent known peers
  providers.js      fixed / known / libp2p / HTTPS / DNS / mDNS
  peer-record.js    signed records + registry
  manager.js        orchestration + honest state
```

## Schema (migration 9)

- `p2p_peer_db` — scored known peers
- `p2p_peer_registry` — signed record cache

## UI

Network page → **Bootstrap & Discovery** card (EN/VI): sources, known, found, joined/waiting.

## Tests

```bash
node --test tests/p2p-bootstrap.test.js
```

## 2.3.1 bootstrap transport notes

- `GET /p2p/bootstrap` is a public, read-only descriptor containing only network, protocol, Peer ID and public multiaddrs.
- HTTP(S) fixed seeds are rendezvous endpoints, not dial addresses. Providers fetch the descriptor and dial only returned multiaddrs that include the advertised Peer ID.
- New nodes register their public peer record with the configured HTTP rendezvous seed. The seed returns a bounded list of known public peers; clients dial only public multiaddrs bound to the advertised Peer ID. The Peer ID is authenticated by libp2p Noise on connection.
- The public multiaddr is derived from `HUB_PUBLIC_URL` and the existing WebSocket gateway. A path-prefixed reverse proxy is deliberately not advertised until path-aware gateway support exists. Private/LAN multiaddrs are rejected by the public registry.
- Docker Compose enables the P2P adapter and WebSocket gateway by default; libp2p packages are installed in the image. No additional public port is required.
- A successful `/health` response alone does not prove WebSocket reachability. Verify `/p2p/bootstrap` returns `status: advertised` with at least one multiaddr, then test a real second node from outside the host network. A registry response is a discovery hint, not proof that a peer is online.
