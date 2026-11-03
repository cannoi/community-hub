# Federation protocol v1

## Identity
`account_id = "hub1_" + base32lower(SHA-256(raw 32-byte Ed25519 public key))` (52 chars). The key, not the IP, is the identity; endpoints can change.

## Event envelope (`schema_version: 1`)
`event_id, actor_id, actor_pub, sequence, previous_event_hash, created_at, event_type, payload, [parent], [target], signature`
* Canonical form `hub-canon-v1`: JSON, keys sorted, no whitespace, integers only.
* `event_id = "ev1_" + hex(SHA-256(canonical(envelope without event_id, signature)))`
* `signature = Ed25519("hub-event-v1\0" + canonical)`; `actor_id` must derive from `actor_pub`.
* `sequence` starts at 1 per actor; `previous_event_hash` = previous `event_id` (null for #1).
* Limits: 32 KiB/event, ≤ 200 events/batch, payload fields strictly whitelisted per type, `created_at` ≤ now+10 min.
* Unknown schema versions/types are **rejected, not partially applied**.

## Ingestion outcomes
`accepted` · `duplicate` (idempotent) · `gap` (expected sequence recorded in `ledger_gaps`, caller fetches the missing range) · `conflict` (same sequence, different content or wrong previous hash → recorded in `event_conflicts`, actor flagged, first history kept) · `rejected` (shape, signature, id, size, schema, blocked actor, internal error ⇒ transaction rolled back).

## Peer authentication
* `GET /federation/v1/hello?nonce=N` (public): returns `{account, pub, endpoint, nonce, sig}` where `sig` signs `account\0endpoint\0nonce`. The client checks key↔account binding, nonce freshness, **that the signed endpoint equals the URL it contacted**, and the optional pin (`hub1_…@https://host`). A bootstrap/discovery source can therefore only point at endpoints; it cannot impersonate an account.
* All other calls carry `X-Hub-Account/Pub/Time/Nonce/Aud/Sig` (+ optional `X-Hub-Endpoint`). Signature covers method, path+query, time, nonce, **audience (the recipient’s account id)** and SHA-256 of the body. ±120 s clock window, nonce replay cache, wrong audience refused.

## Endpoints
| | |
|---|---|
| `GET /federation/v1/events?cursor&limit` | public ledger events after local cursor `lid` (bounded batch, `has_more`, `head`) |
| `GET /federation/v1/events/actor/:id?from&limit` | one actor’s contiguous range (gap repair) |
| `GET /federation/v1/peers` | known healthy peers (verified by the receiver before use) |
| `POST /federation/v1/poke` | “I have new events”; receiver pulls with its own cursor |
| `GET /federation/v1/media/:hash` | **public** media only (Range supported); restricted media → 404 |

## Sync algorithm
Pull-based per peer: handshake → fetch batches from stored cursor (≤ 20 batches/cycle) → ingest → on `gap` fetch actor range → persist cursor. Failure ⇒ `fail_streak++`, retry after `min(max, base·2^n)·(0.5–1.0 jitter)`. Cursor ahead of peer head (peer restored from backup) ⇒ restart at 0. Events are relayed (gossip) because they are self-authenticating, so A→B→C works without A knowing C. Federation modes: `open` (default; any validly signed peer may read public events; unknown peers introduce themselves and are verified by hello) or `allowlist`.

## Endpoint change
Publish `endpoint.announce` (signed). Peers learn the new URL from the announcement, from the old endpoint’s signed hello (“moved”), or from the next signed request; the new URL is added as a *candidate pinned to the same account*, verified by its own hello, then merged into the existing peer row (cursor kept). Tested.

## What this is not
No global consensus, ordering, Byzantine tolerance or censorship resistance. Hash chaining gives per-actor tamper evidence and fork detection only. Transport interface (`request`, `download`) is small so WebSocket/relay/direct transports can be added; only HTTP(S) exists today.
