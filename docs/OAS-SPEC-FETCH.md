# Fetching an OpenAPI document from a URL (OAS-08a)

`SpecFetcherService` (`apps/api/src/modules/spec-fetch/`) is the **only** code path allowed to fetch a
tenant-supplied spec URL. Callers inject it (`SpecFetchModule` exports the class and the
`SPEC_FETCHER` token) and receive either the document text or a `SpecFetchError` with a fixed code.
It adds no parsing: the text then goes through the same gates as an uploaded document
([OAS-IMPORT.md](OAS-IMPORT.md)).

A tenant admin chooses the URL and the API process fetches it, so this is a server-side request
forgery surface by construction. Everything below exists to keep that request away from the platform
itself, its neighbours and cloud metadata.

## Policy

1. **URL** — `http` or `https`, at most 2048 characters, a host, **no userinfo**. The WHATWG parser
   normalises the host first, so `http://2130706433/`, `0x7f.1`, `0177.0.0.1`, `127.1`, full-width
   letters and IDNs (→ punycode) are judged by what they really are.
2. **Name** — refused when the platform denylist (`proxyUrlDenyReason`, the `proxyUrl` validator)
   refuses it: every Compose service and `open-gateway-*` container name, `localhost`, `metadata`,
   `metadata.google.internal`, `PROXY_DENY_HOSTS` — plus `*.localhost`, `*.docker.internal`
   (`host.docker.internal`, `gateway.docker.internal`), `kubernetes` and `kubernetes.default*`.
   Checked before DNS and **also for allow-listed names**.
3. **Every address** — the host is resolved once per hop and **every** answer must pass; one bad
   address refuses the URL. Resolution uses c-ares (`dns.Resolver`, A + AAAA, 2.5 s × 2 tries,
   cancelled at the deadline), not getaddrinfo: a DNS server that never answers cannot hold a libuv
   thread. c-ares does **not** read `/etc/hosts` and applies no `search` domains, so allow-list
   internal hosts by fully-qualified name. After un-mapping `::ffff:a.b.c.d`:
   - `unicast` (per `ipaddr.js`; for IPv6 also inside `2000::/3`) → allowed;
   - `private` (10/8, 172.16/12, 192.168/16), `uniqueLocal` (fc00::/7), `carrierGradeNat` (100.64/10)
     → allowed **only** through the allow-list;
   - **cloud metadata** → refused before the allow-list is consulted, so no entry can lift it:
     `169.254/16` (AWS/GCP/Azure/OCI IMDS), `100.100.100.100` and `100.100.100.200` (Alibaba, inside
     CGNAT), `fd00:ec2::/32` (AWS IPv6 IMDS, inside ULA), `168.63.129.16` (Azure WireServer, public
     by range), `192.0.0.192` (Oracle);
   - **this container's own interface networks** (`os.networkInterfaces()`, i.e. the Compose
     networks) → refused for every name, allow-listed or not;
   - everything else → refused for every name, allow-listed or not: loopback, unspecified,
     `0.0.0.0/8`, link-local (incl. `169.254.169.254`), multicast, broadcast, `240/4`, `192.0.0.0/24`,
     `198.18/15`, documentation ranges (192.0.2/24, 198.51.100/24, 203.0.113/24, 2001:db8::/32,
     3fff::/20), 6to4 relay and `2002::/16`, Teredo and the rest of `2001::/23`, NAT64
     (`64:ff9b::/96`, `64:ff9b:1::/48`), `rfc6145`, IPv4-compatible `::/96`, `100::/64`,
     `fec0::/10`, `5f00::/16`, and any IPv6 address outside `2000::/3`. `ipaddr.js` 1.9.1 calls
     `198.18/15`, `2001::/23` (minus Teredo) and `3fff::/20` unicast, so `spec-url-policy.ts` lists
     those explicitly.
4. **Pinning** — the request uses `node:http` / `node:https` with a dedicated `Agent` and a custom
   `lookup` that answers **only** with the addresses validated in step 3 (single-address and
   `{ all: true }` signatures). The socket cannot connect anywhere the policy has not seen, so DNS
   rebinding between check and connect is not possible. `Host` and TLS SNI stay the original name.
   Never `fetch`/undici. Proxy environment variables (`HTTP(S)_PROXY`, `NODE_USE_ENV_PROXY`) do not
   change the destination: only Node's global agents honour them, and they are not used.
5. **Redirects** — followed manually, at most **3**. A relative `Location` is resolved against the
   current hop; every hop goes through steps 1–4 again (a port change is re-checked against the
   allow-list's port rule). A `Location` with userinfo is refused (`BAD_URL`); `https → http` is
   refused. After a hop leaves the original origin, `If-None-Match` / `If-Modified-Since` are no
   longer sent.
6. **Bounds** — one **10 s** deadline for the whole call (waiting for a slot, DNS, every hop, the
   body); body **≤ 5 MB** counted while streaming (a larger `Content-Length` is refused before
   reading); `GET` only, `Accept-Encoding: identity`, no cookies or credentials, HTTP/1.1; at most
   **2 calls at once per API process** — `fetch` and `validateUrl` share the slots and the deadline.
   At most 20 more wait; beyond that a call fails at once with `TIMEOUT`. A slot is given back when
   its call finishes **or** its deadline passes, whichever is first, and an expired waiter leaves the
   queue.
7. **Body** — decoded as UTF-8, a BOM stripped. Nothing is decompressed: gzip bytes a server sends
   anyway reach the lint gate as bytes and fail there (`NOT_A_SPEC`, added by the backend).

Only `200` is a success; `304` is `NOT_MODIFIED` only when a validator was sent. ETag / Last-Modified
values longer than 512 characters are dropped.

## Allow-list — `SPEC_FETCH_ALLOWED_HOSTS`

Comma-separated, read once at startup. Empty (the default) means public hosts only.

| Entry | Meaning |
|---|---|
| `specs.corp.example` | this exact name may resolve to private / ULA / CGNAT addresses, on the scheme's default port only |
| `specs.corp.example:8443` | same, on port 8443 only (`:443` / `:80` match the default-port URL too) |
| `10.20.0.0/16`, `10.30.0.7` | these private addresses, default ports |
| `10.30.0.7:8080`, `[fd12:3456::/32]:9000` | these addresses on that port only |

- The allow-list **only** relaxes the private, ULA and CGNAT ranges. An allow-listed name that
  resolves to loopback, metadata, this container's own networks or any other refused range is
  still refused.
- Every entry is normalised the way a URL host is: a numeric spelling (`172.18.3`, `0x7f.1`,
  `2130706433`) is the address it denotes and gets the CIDR checks, not a name.
- **It is installation-wide.** Every tenant of this installation can make the API fetch from every
  allow-listed host. List only hosts whose content any tenant admin may read.
- Startup **fails** (the API does not boot, and the error names the entry) when an entry is not a
  valid name / IP / CIDR / port, when a name is on the platform denylist, or when a CIDR **overlaps
  one of the API container's own interface networks** (`os.networkInterfaces()`): such a range would
  expose every Compose service by IP. Allow-list an internal host on those networks by name instead.
- The Compose / prod-overlay wiring of the variable is done by the lead (next to `PROXY_DENY_HOSTS`).
- **Test-only opt-out.** `SpecFetchOptions.allowOwnNetworks` (the `SPEC_FETCH_OPTIONS` constructor
  token) lifts the own-network rule for allow-listed hosts. It exists only so the live e2e can serve
  a spec from the api container itself. Production DI never provides the token and there is no
  environment variable for it; metadata and every other rule still apply.

## TLS and authentication

- Certificates are always verified. An internal host signed by a private CA fails with
  `UNREACHABLE` until that CA is trusted: add it with `NODE_EXTRA_CA_CERTS` on the api container.
  Verification is never disabled.
- **userinfo is unsupported**: Basic-auth-protected specs cannot be fetched. Put a token in the
  query string instead (`https://host/openapi.yaml?token=…`). The URL is never logged or returned;
  `redactSpecUrl` shows `https://host/…` only.

## Errors

`SpecFetchError.code` and a fixed message; the message never contains the URL, a redirect
`Location` or text from the remote server. The service logs nothing.

| Code | When |
|---|---|
| `BAD_URL` | not http(s), too long, no host, userinfo, or a redirect `Location` that is not a valid http(s) URL without userinfo |
| `BLOCKED_TARGET` | refused by policy **or** the name does not resolve — the same code, so the fetcher is not an oracle for which internal names exist |
| `UNREACHABLE` | connection refused/reset, TLS failure, the response ended early |
| `TIMEOUT` | the 10 s deadline passed, or 2 calls run and 20 wait already |
| `TOO_LARGE` | more than 5 MB |
| `TOO_MANY_REDIRECTS` | a 4th redirect |
| `HTTP_<status>` | any other status (`HTTP_404`, `HTTP_500`, a redirect without `Location`, `HTTP_304` to an unconditional request) |

`validateUrl(url)` applies steps 1–3 (including DNS) without connecting, under the same deadline
and slots, and throws `BAD_URL`, `BLOCKED_TARGET` or `TIMEOUT`.

## Evidence

- Unit (offline, `spec-url-policy.spec.ts`, `spec-fetcher.service.spec.ts`): the range table, URL
  spellings, allow-list parsing/refusals, and the fetcher over real `node:http` sockets to a local
  server with an injected resolver — pinning, `{ all: true }`, rebinding, redirects, conditionals,
  size, deadline, slot release after a hung DNS lookup, queue bound, metadata, own networks, error
  text. The first version was run against a naive `fetch(url)` + name-denylist implementation
  (94 of 191 tests failed) and under 25 mutations of the policy and fetcher (24 killed; the
  survivor was a redundant range, then removed); the review fixes were each reverted once (12
  mutations, 11 killed). The survivor is the removal of an expired waiter from the queue: with one
  deadline length for every call, a waiter always expires after the holders ahead of it, so no test
  can observe it; it is kept as memory hygiene. Not unit-tested: the c-ares default resolver (it
  needs a DNS server) and the proxy environment variables (Node reads them at process start) —
  both are covered by the live e2e only.
- Live (`apps/api/test/e2e/oas-spec-fetch.e2e.mjs`, inside the api container, real DNS and
  transport): see its header. Run only by the lead after a deploy.

## Known limits

- **Timing is not uniform.** A name refused by the denylist answers at once, a name Docker's DNS
  resolves to a private address answers in milliseconds, and a non-existent name answers after the
  resolver's latency. Every refusal has the same code, but an admin timing `PUT …/spec-source` could
  still guess which internal names exist. Accepted.
- **Public targets on any port are reachable**, so the fetcher can probe ports on public hosts from
  the platform's address (`UNREACHABLE` / `TIMEOUT` / `HTTP_*` differ). Accepted.
- **The host's own public address or name counts as public**, including the edge ports published on
  0.0.0.0: the API can re-enter its own edge. Over TLS the internal CA mostly stops it (the
  certificate is not trusted by the API process); a plain-HTTP port published by the host is not
  stopped.

- A **public** name is trusted as far as its DNS answer: a public host that forwards (as a proxy or
  via its own server-side fetch) to somewhere else is outside this control.
- The allow-list is installation-wide, not per tenant.
- The 2-slot limit is per API process; with several API replicas the total is 2 × replicas.
- No general egress choke point exists on the Compose networks; this policy lives in the API process.
- **Out of scope, pre-existing:** `health-check.service.ts` (tenant uptime URLs) and
  `webhook-relay.service.ts` (receiver URLs) fetch tenant-supplied URLs with no resolve-time policy.
  They do not go through this fetcher; closing that gap is separate work.
