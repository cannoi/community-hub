# Security Summary

**Reviewed Files**: 14
**Issues Resolved**: 10

### Issues Resolved
| Area | File | Line | What Was Happening | Impact | Status | How It Was Fixed |
|---|---|---|---|---|---|---|
| Host Network Exposure & DNS Rebinding | `src/net/p2p/bootstrap/probe.js` | 50 | Peer probe requests resolved hostnames dynamically with default DNS lookup and followed redirects, allowing hostname switches or redirects to probe internal host services. | High | Fixed | Bound outbound HTTP/HTTPS requests to `guardedLookup(false)` with `agent: false`, rejected redirects (`3xx`), enforced IPv6 bracket formatting and strict `1..65535` port checks, and capped responses at `64 KiB`. |
| Outbound Crawl & Directory Requests | `src/net/p2p/bootstrap/peer-crawl.js` | 35 | Peer crawler used bare `fetch()` without IP-pinning at socket connect time or redirect refusal. | High | Fixed | Replaced bare `fetch()` with Node `http`/`https` requests using `guardedLookup(false)`, `agent: false`, redirect rejection, a `512 KiB` body cap, and recursive JSON key filtering. |
| Bootstrap Provider Requests | `src/net/p2p/bootstrap/providers.js` | 395 | Bootstrap JSON fetches resolved hosts without connect-time IP checks, lacked response size bounds, and accepted unsigned manifests even when a public key was provided. | High | Fixed | Added `guardedLookup(false)` (blocking private/metadata resolution while preserving test loopback literal), `agent: false`, redirect blocking, `1 MiB` response limit, and real Ed25519 signature verification in `validateManifest` (`line 293`). |
| Directory Client Trust & Confidentiality | `src/net/p2p/bootstrap/directory-client.js` | 20 | Directory registration and bootstrap sync lacked payload encryption and connect-time IP pinning, and preserved private multiaddrs inside returned peer descriptors. | Medium | Fixed | Added AES-256-GCM envelope encryption/decryption (with plaintext fallback during rollout), `guardedLookup`, redirect refusal, `1 MiB` cap, JSON key sanitization, and strict stripping of private multiaddrs from peer entries. |
| Unauthenticated Host IP Disclosure | `src/routes/core.js` | 32 | `GET /health` returned `public_ip` and `public_url` to any unauthenticated caller on the internet. | Medium | Fixed | Removed `public_ip` and `public_url` from the unauthenticated `/health` response payload. |
| Proxy Header Spoofing | `src/routes/federation.js` | 43 | `requestEndpoint` trusted `X-Forwarded-Host` and `X-Forwarded-Proto` unconditionally even when the Hub was not deployed behind a trusted proxy (`trustProxy === 0`). | Medium | Fixed | Restricted forwarding headers strictly to `cfg.trustProxy > 0` and validated `Host` / `X-Forwarded-Host` with `SAFE_HOST_RE` and scheme allowlisting (`http`/`https`). |
| Prototype Key Pollution & Spoofed Client IP | `src/http.js` | 44, 53, 239 | Parsed JSON/URL-encoded bodies, query parameters, and `X-Forwarded-For` values did not strip `__proto__`/`constructor`/`prototype` keys or validate IP syntax. | Medium | Fixed | Added recursive `sanitizeJsonValue` (max depth 50) across JSON/form bodies and query params, validated `X-Forwarded-For` with `net.isIP`, and added `X-DNS-Prefetch-Control: off` & `X-Permitted-Cross-Domain-Policies: none`. |
| Static Path Symlink Escape | `src/http.js` | 306 | Static asset resolution checked normalized paths without resolving symbolic links against the `public/` directory root. | Medium | Fixed | Added `fs.realpathSync` confinement verifying the resolved target remains under `realRoot` before serving. |
| WebSocket & Connection Flooding | `src/net/p2p/ws-gateway.js`, `src/hub.js` | 55, 59; 187-205 | The WebSocket gateway had no per-IP concurrent tunnel cap or upgrade `head` limit, and the main HTTP server had no global or per-IP socket ceiling. | Medium | Fixed | Rejected WebSocket upgrade `head` buffers larger than `4096` bytes, enforced per-IP concurrent tunnel limits (`maxPerIp = 8`), and configured `server.maxConnections`, `maxHeadersCount`, `headersTimeout`, and per-IP active socket tracking. |
| Directory Dependency Advisory | `package-lock.json` | — | `npm audit --omit=dev` flagged an older transitive entry (`@libp2p/kad-dht <16.2.6`) in lockfile metadata even though `package.json` specifies `16.4.10`. | Low | Needs Follow-Up | Verified `package.json` already pins `@libp2p/kad-dht` at `16.4.10`; run a clean lockfile refresh before production deployment if strict advisory checks require lockfile alignment. |

### Safeguards Verified
| Area | File | How It's Protected |
|---|---|---|
| Cloudflare Sync Confidentiality | `src/net/p2p/bootstrap/cloudflare-crypto.js` | Uses WebCrypto-compatible `AES-256-GCM` with `SHA-256` key derivation from `CLOUDFLARE_SYNC_KEY` and random 96-bit IVs, with safe unencrypted fallback when transitioning workers. |
| Database Queries | `src/db.js`, `src/social.js` | Uses prepared parameterized SQL statements (`?` bindings) across all queries. |
| Cross-Origin & Frame Embedding | `src/http.js` | Enforces `isAllowedOrigin` on state-changing requests (`POST`/`PATCH`/`DELETE`), CSRF token validation on authenticated writes, and strict CSP (`script-src 'self'`). |
| Cryptography & Signing | `src/events.js`, `src/keystore.js` | Signs and verifies all federated ledger events and inbound HTTP federation requests using Ed25519 with replay-window protection. |

## PoC Verification

### Uncontrolled Host-Bound Probe / Crawl Requests
#### Summary
| Field | Value |
|---|---|
| Issue Type | Outbound Request Host & Redirect Validation Gap |
| Impact | High |
| Affected File | `src/net/p2p/bootstrap/probe.js:50` |
| Test Scenario | Submitting a peer record pointing to a loopback multiaddr `/ip4/127.0.0.1/tcp/8181/ws/p2p/...` or a domain that switches IP after DNS resolution or redirects to an internal IP. |

#### How It Was Fixed
Outbound probe, crawl, directory, and manifest requests now pin socket-level IP resolution through `guardedLookup(false)`, disable connection reuse (`agent: false`), refuse `3xx` redirects, and enforce strict byte limits.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | A peer record `/ip4/127.0.0.1/tcp/8181/ws/p2p/...` enters `probePeerRecord` at `src/net/p2p/bootstrap/probe.js:88` | Multiaddr is parsed in `multiaddrToHttpBase` |
| 2 | Reaches `isPrivateIp(host)` check at `src/net/p2p/bootstrap/probe.js:34` (using `isPublicIp`) and `guardedLookup(false)` at `line 53` | Loopback/private target is rejected before any TCP socket opens |
| 3 | Final result returns `{ verified: false, reason: 'unreachable' }` | **Handled Safely** |

#### Conclusion
**Fix Verified** - Neither direct internal IPs, private DNS answers, nor `3xx` redirects can force the Hub host to connect to loopback, LAN, or cloud metadata endpoints.

### Unauthenticated Public IP Disclosure
#### Summary
| Field | Value |
|---|---|
| Issue Type | Information Disclosure on Public Health Route |
| Impact | Medium |
| Affected File | `src/routes/core.js:32` |
| Test Scenario | Unauthenticated `GET /health` request inspecting response JSON for `public_ip` or `public_url`. |

#### How It Was Fixed
Removed `public_ip` and `public_url` fields from the public `/health` payload while keeping liveness and non-sensitive service booleans intact.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Unauthenticated caller sends `GET /health` | Routed to `src/routes/core.js:32` |
| 2 | Handler builds status object at `src/routes/core.js:36-48` | Only `status`, `role`, `timestamp`, `version`, `uptime_s`, and `services` booleans/state are returned |
| 3 | Response JSON omits `public_ip` and `public_url` | **Handled Safely** |

#### Conclusion
**Fix Verified** - Anonymous callers checking `/health` can no longer enumerate the host machine's public IP address.

### JSON Prototype Pollution & Proxy Header Spoofing
#### Summary
| Field | Value |
|---|---|
| Issue Type | Untrusted Input Object Key Injection & Proxy Header Spoofing |
| Impact | Medium |
| Affected File | `src/http.js:54`, `src/routes/federation.js:43` |
| Test Scenario | Sending `{"content":"safe","__proto__":{"isAdmin":true},"constructor":{"prototype":{"pwned":true}}}` to `POST /api/posts`, or `X-Forwarded-Host: evil.attacker` when `trustProxy` is `0`. |

#### How It Was Fixed
Added recursive `sanitizeJsonValue` (stripping `__proto__`, `constructor`, `prototype` and limiting nesting depth to 50) in `parseJsonBody` and query parsing, and restricted `requestEndpoint` forwarding headers to deployments with `trustProxy > 0` plus `SAFE_HOST_RE` validation.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Payload arrives at `parseJsonBody` (`src/http.js:74`) or `requestEndpoint` (`src/routes/federation.js:43`) | Parsed JSON / headers inspected |
| 2 | `sanitizeJsonValue` strips `POLLUTION_KEYS` (`src/http.js:60`); `requestEndpoint` sees `useForwarded === false` (`src/routes/federation.js:44`) | Dangerous keys removed and spoofed `X-Forwarded-Host` ignored |
| 3 | `Object.prototype` remains unmodified and server endpoint stays authentic | **Handled Safely** |

#### Conclusion
**Fix Verified** - Attackers cannot inject prototype keys through API payloads or spoof the Hub's federation endpoint via proxy headers.

### WebSocket Upgrade & Tunnel Exhaustion
#### Summary
| Field | Value |
|---|---|
| Issue Type | Missing Per-IP WebSocket Tunnel & Upgrade Buffer Limits |
| Impact | Medium |
| Affected File | `src/net/p2p/ws-gateway.js:55` |
| Test Scenario | Sending an HTTP WebSocket upgrade with a `5000`-byte trailing `head` buffer or opening more than `maxPerIp` concurrent tunnels from a single IP. |

#### How It Was Fixed
Enforced a `4096`-byte maximum on WebSocket upgrade `head` buffers, tracked per-IP active tunnels in `ipCounts` with automatic decrement on close, and bounded total HTTP server sockets globally and per IP in `src/hub.js`.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Upgrade request enters `WsGateway._onUpgrade` (`src/net/p2p/ws-gateway.js:49`) | Validated for headers and path |
| 2 | `head.length > 4096` (`line 55`) or `(this.ipCounts.get(ip) || 0) >= this.maxPerIp` (`line 59`) triggers `_reject` | Oversized or excessive tunnels rejected with `400`/`429` before dialing backend |
| 3 | Host loopback backend and socket table stay protected from exhaustion | **Handled Safely** |

#### Conclusion
**Fix Verified** - Single-source upgrade floods and oversized upgrade frames are rejected before allocating backend loopback tunnels.
