# Phase 4 — Regional / Language Directory (2.3.25)

## Delivered
- **RegionalDirectory** (`src/net/p2p/bootstrap/directory.js`)
  - Peer metadata only (not full post index)
  - Fields: peer_id, multiaddrs, region, languages, topics, shard, seq
  - Pagination + `cursor` incremental updates
  - Region/language **bias** order — does not hard-filter other regions
  - Stable shard by peer_id hash
  - TTL prune + max entries eviction
- Seed routes: `GET /p2p/directory`, `GET /p2p/directory/stats`
- Register path writes verified peers into regional directory
- Config: `HUB_REGION` / `PRESENCE_REGION`, `HUB_LANGUAGES` (default `vi,en`)

## Gate
| Item | Status |
|------|--------|
| Not loading full global post index | PASS (peer directory only) |
| Find peers outside preferred region | PASS (bias, not exclude) |
| IP change keeps peer_id | PASS (unit) |
| Multi-region Internet scale | Not claimed |

## Rollback
- In-memory directory; restart clears. No DB migration.
