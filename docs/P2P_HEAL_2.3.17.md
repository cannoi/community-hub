# 2.3.17 — P2P address heal, probe-back, clearer sync

## Root causes fixed
1. **Wrong port advertise**: no longer invents `:8181` when port unknown → status `address-unverified` instead.
2. **Peer id mismatch**: dial problems classified; `noteWrongPeer` drops conflicting records; refuse dial-to-self; soft-skip same public IP (hairpin).
3. **Probe-back** on `POST /p2p/register`: only accept records that answer `/p2p/bootstrap` with matching `peer_id` (and optional source IP match).
4. **UI**: dial errors grouped in `problems[]`; when ≥1 healthy link, no global red dial banner.
5. **Sync reason** per peer: `link_only` | `waiting_remote` | `syncing` | `enabled_pending` | `error`.

## SoloHost env (your case: public port 8182)
```
HUB_PUBLIC_URL=http://14.176.78.46:8182
P2P_PUBLIC_PORT=8182
HOST_PORT=8182
```
Seed remains `http://14.176.78.46:8181`. Do not advertise 8181 if your Hub is published on 8182.

## Mutual content sync
Both Hubs need sync enabled; one side alone stays `link_only` / `waiting_remote`.
