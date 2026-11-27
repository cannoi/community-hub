# Migration and rollback guide

| Migration | Adds | Reversible by |
|---|---|---|
| 10 | `p2p_index_documents/terms/shards/assignments` | ignored by older code |
| 11 | `origin_sig` column, `p2p_index_tombstones`, `p2p_index_shard_state`, `p2p_index_oplog` | ignored by older code |
| 12 | `remote_tombstones`, `integrity_findings`, `events_quarantine`, `remote_actors.snap_seq` | ignored by older code |

All are additive (no row rewritten, no column dropped). **Rollback to an older image: older versions refuse to start on a database with migrations they do not know — restore the pre-upgrade backup instead** (`npm run restore`). User data (events, accounts, posts, groups, keys) is never touched by these migrations.

## Feature flags (rollback without redeploying code)
`P2P_FEDERATED_SEARCH=0` · `P2P_INDEX_REPLICATION` unset · `HUB_HEAL_INTERVAL_MS=0` · `HUB_ANTI_ENTROPY_MS=3600000000`. Snapshot `after=` is backward compatible both ways.

## Procedure
1. `npm run backup` (or copy `data/`) and keep the previous image tag. 2. Deploy. 3. Verify. 4. If a critical check fails: stop, restore the backup, run the previous image. Do NOT copy a different Hub's data directory over this one.

## Behavioural changes to know about
Per-peer "sync off" is now honoured for trusted peers; unverifiable peer records are rejected by probe-back; P2P is ON by default (zero-config) — pass `p2p: { enabled: false }` / the existing switch to run HTTPS-only.
