# PROMPT B continuation — 2.4.2

## Done this pass
| Phase | Item |
|-------|------|
| 3 | `publicIp` from `HUB_PUBLIC_URL`; honest reachability unchanged |
| 4 | peer-info normalize retained; discovery continues on single bad addr |
| 5 | Federation `hello`/`call` try same-host HTTP candidates; multiaddr→HTTP via `httpEndpointFromMultiaddr` |
| 5 | Directory peers get derived `endpoint` for crawl/federation |
| 7 | `/api/sync/status` exposes `directory` status (owner); i18n EN+VI `net.dir.*` |
| 8 | Tests: directory-client, same-host-fed, peer-info normalize |

## Not done / NOT RUN
| Item | Reason |
|------|--------|
| Production POST register to Cloudflare Worker | Needs owner authorization |
| Two SoloHost Hubs bidirectional sync evidence | No live dual-Hub session here |
| 8182 unhealthy root-cause on owner machine | Needs their compose logs |
| Full Playwright Explore Network | Not executed |
| Heavy Network UI redesign | Avoided breaking existing simple Network UI; keys ready for light binding |

## Preserve
AI assistant language matching, EN+VI UI, ledger, groups, media, auth — unchanged.
