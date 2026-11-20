# 2.3.12 — Fully automatic network (no user input)

- Built-in discovery seed: `http://14.176.78.46:8181` (invisible to end users)
- Each Hub auto-detects its public IPv4 (ipify / ifconfig.me / icanhazip / AWS checkip)
- Builds `http://<ip>:8181` and advertises P2P multiaddrs
- Cache: `data/public-ip.cache.json`
- SoloHost: `options: []` — install with no form fields
