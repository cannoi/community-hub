# 2.3.11 — Network auto-discovery (seed :8181)

## Primary seed
- `http://14.176.78.46:8181` — first CANNOI rendezvous (Presence + `/p2p/bootstrap`)
- Extend later: `P2P_FIXED_SEEDS=http://14.176.78.46:8181,http://other:8181`

## P2P dial port
- `P2P_PUBLIC_PORT=8181` — advertised in multiaddrs as `/ip4/<PUBLIC_IP>/tcp/8181/ws/p2p/<PeerId>`
- Map host `8181` → container `8080` (HTTP + WS gateway)

## Operator checklist (seed machine)
```bash
HUB_PUBLIC_URL=http://14.176.78.46:8181
PUBLIC_IP=14.176.78.46
P2P_PUBLIC_PORT=8181
P2P_WS_GATEWAY=true
PRESENCE_SERVE=true
```
Verify: `curl -s http://14.176.78.46:8181/p2p/bootstrap` → `status: advertised`, non-empty `multiaddrs`.

## Other Hubs
```bash
P2P_FIXED_SEEDS=http://14.176.78.46:8181
PRESENCE_SEEDS=http://14.176.78.46:8181
HUB_PUBLIC_URL=http://<this-hub-public-ip>:8181   # must be THIS machine
PUBLIC_IP=<this-hub-public-ip>
P2P_PUBLIC_PORT=8181
```
