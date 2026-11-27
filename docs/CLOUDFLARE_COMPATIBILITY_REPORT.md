# Cloudflare Worker ↔ Community Hub compatibility

**Worker URL:** `https://cannoi-community-bootstrap.huunghitran-datxanh.workers.dev`  
**Captured:** 2026-11-22T16:34:01Z (read-only GET; no production POST performed)

## Verified facts (from live HTTP)

| Endpoint | Status | Key fields |
|----------|--------|------------|
| `GET /` | 200 | `service=cannoi-community-bootstrap`, `role=rendezvous-seed`, `status=directory`, endpoints map |
| `GET /health` | 200 | `ok=true`, `database=ok`, `active_peers=0`, **`probe_back=true`**, **`probe_strict=false`** |
| `GET /p2p/bootstrap` | 200 | `network=cannoi`, `status=directory`, `peer_id=null`, `multiaddrs=[]`, `peers=[]`, `registry.limit=200` |
| `GET /p2p/stats` | 200 | `active_peers=0`, `verified_peers=0`, `total_records=0` |

CORS: `access-control-allow-origin: *`, methods GET, POST, OPTIONS.

## Unverified (no Worker source; no production register)

- Exact JSON schema accepted by `POST /p2p/register`
- Whether probe-back hits Hub `GET /p2p/bootstrap` over **HTTP** only (Worker cannot open WebSocket/TCP multiaddrs from CF edge without special APIs)
- TTL defaults, eviction policy, max body size
- Behaviour when `probe_strict=true`

## Hub record shape (source of truth)

```json
{ "record": {
  "peer_id": "12D3KooW…",
  "network": "cannoi",
  "protocol": "1.0.0",
  "multiaddrs": ["/ip4/…/tcp/8181/ws/p2p/12D3KooW…"],
  "capabilities": ["hub","gossip","sync"],
  "reachability": "private|public|unknown",
  "registered_at": 0,
  "expires_at": 0,
  "signature": null
}}
```

## Probe-back implication

Worker reports `probe_back: true`. A CF Worker can HTTP-fetch `http://PUBLIC_IP:PORT/p2p/bootstrap` and check `peer_id` match. It **cannot** complete a libp2p Noise handshake over `/ws` multiaddr unless implemented with a TCP/WebSocket client and full stack (unlikely on Workers). Therefore:

- Hubs **must** expose HTTP `/p2p/bootstrap` on the **public** port (`P2P_PUBLIC_PORT` / SoloHost published port).
- `address_verified=false` on the Hub remains honest for libp2p dialability; directory registration can still succeed via HTTP probe.

## Integration choices (implemented)

| Setting | Role | Default |
|---------|------|---------|
| `P2P_DIRECTORY_SEEDS` | Rendezvous/register only | Cloudflare Worker URL |
| `P2P_FIXED_SEEDS` | Optional fixed Hub peers | empty (no self-seed) |
| `PRESENCE_SEEDS` | Presence directory | unchanged / operator |

Worker is **not** a content relay and **not** a single point of failure: fixed seeds, peer exchange, and cache still work when the Worker is down.

## Production register

**Not executed** in this environment (PROMPT: no unauthorized POST). Operators should register once with explicit approval or use a staging Worker. Hub-side client is ready (`DirectoryClient.register`).
