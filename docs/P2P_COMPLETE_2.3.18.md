# 2.3.18 — Remaining P2P phases

## Completed beyond 2.3.17
1. **Mutual sync invite**: `want_sync` on `/federation/v1/connect`; `POST /api/peers/:id/invite-sync`; pending marker `SYNC_INVITE_PENDING`.
2. **host:port uniqueness** in PeerRegistry (evict older when new verified claims same address).
3. **UI**: `sync_reason` text + **Invite sync** button on healthy peers without content sync.
4. **i18n** EN/VI for invite strings.

## Still operator-dependent
- Set `P2P_PUBLIC_PORT` / `HUB_PUBLIC_URL` to the **published** SoloHost port (e.g. 8182).
- Content sync still requires global `trusted` mode + mutual consent.
