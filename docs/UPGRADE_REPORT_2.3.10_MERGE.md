# 2.3.10 — Integrate 2.3.5 P2P network repair + 2.3.9 smoke packaging

## From 2.3.5 (kept)
- Docker/Compose defaults: P2P_ENABLED, P2P_WS_GATEWAY, PRESENCE_SERVE
- Compose: HUB_PUBLIC_URL / PUBLIC_URL empty by default (must be THIS Hub's URL, not seed)
- PRESENCE_SEEDS / P2P_FIXED_SEEDS → shared rendezvous http://14.176.78.46:28090
- Bootstrap providers accept directory seeds (status=directory without peer_id)
- seed-routes, presence seed-server upgrades, AI knowledge about seed vs public URL
- deployment-network-defaults tests, multi-hub directory tests

## From 2.3.9 (smoke)
- No Dockerfile VOLUME (prevents root-owned data crash as USER node)
- HOST=0.0.0.0 PORT=8080 DATA_DIR explicit
- docker-entrypoint.sh
- /health role=community-hub + services snapshot
- unhandledRejection does not kill listener
- GitHub Actions smoke via community-hub:ci

## Not changed
Social, auth, posts, media, AI providers, i18n dictionaries, Feedback implementation.
