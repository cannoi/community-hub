# PROMPT — Tinh chỉnh Cloudflare Worker Bootstrap cho Community Hub

> Dán **toàn bộ** nội dung từ dòng "ROLE:" trở xuống cho AI (Claude / GPT) khi sửa Worker  
> `https://cannoi-community-bootstrap.huunghitran-datxanh.workers.dev`  
> Kèm source Worker hiện tại nếu có.

---

ROLE: Senior Cloudflare Workers + distributed systems engineer. You maintain the **CANNOI Community Bootstrap** Worker (rendezvous / directory only — never content relay). Community Hub (Node.js self-hosted app, network id `cannoi`) registers and discovers peers through this Worker. Match the Hub contract below **exactly**. Do not invent Hub-side fields.

## Verified live Worker behaviour (2026-11-22, GET only)

- `GET /` → `{ service, version, network:"cannoi", protocol:"1.0.0", role:"rendezvous-seed", status:"directory", endpoints:{ health, bootstrap, register, stats } }`
- `GET /health` → `{ ok, service, version, network, protocol, database:"ok", active_peers, probe_back:true, probe_strict:false, time }`
- `GET /p2p/bootstrap` → `{ network:"cannoi", protocol:"1.0.0", status:"directory", role:"rendezvous-seed", peer_id:null, multiaddrs:[], peers:[], count, version, updated_at, registry:{ service, limit:200, verified_only } }`
- `GET /p2p/stats` → `{ ok, service, network, active_peers, verified_peers, total_records, time }`
- CORS: `Access-Control-Allow-Origin: *`, methods GET, POST, OPTIONS

## Hub client contract (source of truth)

### POST `/p2p/register` body (JSON)

```json
{
  "record": {
    "peer_id": "12D3KooW…",
    "network": "cannoi",
    "protocol": "1.0.0",
    "multiaddrs": [
      "/ip4/PUBLIC_IP/tcp/PUBLIC_PORT/ws/p2p/12D3KooW…"
    ],
    "capabilities": ["hub", "gossip", "sync"],
    "reachability": "public|private|unknown",
    "registered_at": 1730000000000,
    "expires_at": 1730086400000,
    "signature": null
  }
}
```

Rules Hub expects:

1. Accept **wrapped** `{ "record": {…} }` (preferred). Optionally also accept bare record for debugging.
2. Require `peer_id` (string, libp2p peer id, typically base58, length ~30–80) and **at least one** multiaddr string starting with `/` containing `/p2p/<same peer_id>`.
3. `network` must be `cannoi` if present; reject other networks with **400** `{ "error":"wrong_network" }`.
4. **Reject private multiaddrs** for storage in the public directory: `/ip4/127.*`, `10.*`, `192.168.*`, `172.16–31.*`, `::1`, `fe80:`. If after filter zero public multiaddrs remain → **400** `{ "error":"private_address" }`.
5. Cap multiaddrs ≤ 8, body ≤ 64 KiB, capabilities ≤ 16 strings.
6. TTL: if `expires_at` missing, set `now + 24h`. Cap max TTL (e.g. 7 days). Drop expired on read.
7. **Probe-back (recommended when `probe_back:true`)**:  
   - Derive HTTP base from multiaddr: `http://HOST:PORT` (or https if `/wss`).  
   - `GET {base}/p2p/bootstrap` with short timeout (3–5s).  
   - Success if JSON has `peer_id` matching the registered id **or** a peer entry with that id, and `network=cannoi`.  
   - Cloudflare Worker **cannot** complete libp2p/WebSocket Noise handshake — **HTTP probe only**.  
   - If `probe_strict:false` (current): store record even if probe fails, set `verified:false`, still list on bootstrap (Hub already does this).  
   - If `probe_strict:true`: only list verified records when `registry.verified_only` is true.
8. Response **200**: `{ "ok":true, "peer_id":"…", "expires_at": number, "verified": boolean }`.  
   **429** with Retry-After on abuse. **400** validation errors with stable `error` codes.

### GET `/p2p/bootstrap` response peers[]

Each peer object MUST be listable by Hub sanitize:

```json
{
  "peer_id": "12D3KooW…",
  "network": "cannoi",
  "protocol": "1.0.0",
  "multiaddrs": ["/ip4/…/tcp/…/ws/p2p/12D3KooW…"],
  "capabilities": ["hub","gossip","sync"],
  "reachability": "unknown",
  "endpoint": "http://PUBLIC_IP:PORT",
  "expires_at": 1730086400000,
  "verified": false
}
```

- `endpoint` optional but **strongly recommended**: `http(s)://host:port` derived from multiaddr so Hub federation can dial without guessing.
- Do **not** put the Worker itself as a dialable peer (`peer_id` null, empty multiaddrs at top level is correct for `status:"directory"`).
- Limit ≤ 200 peers; prefer freshest `registered_at`.

### Multiaddr format Hub uses

```
/ip4/<IPv4>/tcp/<port>/ws/p2p/<peerId>
```

Optional later: `/dns4/<host>/tcp/<port>/wss/p2p/<peerId>` → probe with `https://host:port`.

## Hard constraints

1. Worker is **directory only** — never proxy chat, posts, media, or private data.
2. No single point of failure for Hub: if Worker is down, Hubs still run offline / fixed seeds.
3. Rate-limit register per IP and per `peer_id` (e.g. 30/hour).
4. Idempotent register: same `peer_id` overwrites previous record.
5. Keep `GET /health` `probe_back` and `probe_strict` accurate.
6. Durable storage (D1/KV/DO) with expiry index; `database:"ok"` only if storage reachable.
7. Do not require Hub authentication for public directory; optional future HMAC is out of scope unless specified.
8. Logging: status, latency, reject reason — no full multiaddr dump to public logs if privacy-sensitive.

## Acceptance tests for Worker

1. POST valid public record → 200 → appears in GET `/p2p/bootstrap` peers[].
2. POST only `127.0.0.1` multiaddr → 400 `private_address`.
3. POST wrong network → 400.
4. POST oversized body → 413/400.
5. Expired record not listed.
6. Probe-back against a reachable Hub `/p2p/bootstrap` sets `verified:true` when possible.
7. OPTIONS CORS preflight succeeds for POST from browser origins.
8. GET `/p2p/stats` counts match storage.

## Deliverables from Worker AI

- Updated Worker source
- Short CHANGELOG
- Example curl for register + bootstrap
- Note on D1/KV schema and TTL job
- Explicit statement of probe-back limits (HTTP only)

## Example curl (operator)

```bash
# After Hub is publicly reachable on PORT:
PEER_ID="12D3KooW…"   # from Hub /p2p/bootstrap
curl -sS -X POST "https://cannoi-community-bootstrap.huunghitran-datxanh.workers.dev/p2p/register" \
  -H "content-type: application/json" \
  -d "{\"record\":{\"peer_id\":\"$PEER_ID\",\"network\":\"cannoi\",\"protocol\":\"1.0.0\",\"multiaddrs\":[\"/ip4/14.176.78.46/tcp/8181/ws/p2p/$PEER_ID\"],\"capabilities\":[\"hub\",\"gossip\",\"sync\"],\"reachability\":\"unknown\",\"registered_at\":$(date +%s000),\"expires_at\":$(($(date +%s)+86400))000,\"signature\":null}}"

curl -sS "https://cannoi-community-bootstrap.huunghitran-datxanh.workers.dev/p2p/bootstrap"
```
