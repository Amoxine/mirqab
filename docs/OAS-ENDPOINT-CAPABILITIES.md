# What Tyk OSS 5.15.0 enforces per OpenAPI operation

Measured 2026-09-25 (OAS-02) on `tykio/tyk-gateway:v5.15.0`
(`sha256:0c8fcb5784b5d4960ee2609be655d22fd3cd1aaaba569cd2211901c85b8443d3`), the image this stack runs.
The evidence is executable: `pnpm --filter @open-gateway/api test:e2e:oas-capabilities` (40 checks) and
the table in `apps/api/src/modules/api-management/services/endpoint-capabilities.ts`. **Re-run the e2e
after every gateway upgrade**; a changed behaviour fails it.

## Why this exists

`x-tyk-api-gateway.middleware.operations.<operationId>` **accepts** 23 controls (the list is read from
the gateway's own embedded schema, `__fixtures__/tyk-oas-operation-fields.v5.15.0.json` — not from
documentation, which has described newer releases than this image). Accepting is not enforcing: in this
repo `middleware.mcpTools.<tool>.rateLimit` validated, round-tripped and was never enforced. So each
control was tested with a request that must change behaviour and a control request that must not, against
a local upstream that counts the calls it receives.

## Results

| Control | Verdict | What the gateway does |
|---|---|---|
| `block` | **enforced** | 403 `Requested endpoint is forbidden`, upstream never reached; matches templated paths (`/x/{id}`); siblings and other methods on the same path unaffected |
| `allow` | **enforced** | one `allow` on an API switches on **allow-list mode**: every declared operation without it *and* every undeclared path answers 403 |
| `ignoreAuthentication` | **enforced** | on an authenticated API the operation answers without a key (200); its siblings still answer 401 |
| `rateLimit` | **enforced** | 429 past `rate` per `per`; **one counter shared by all consumers** (key 1 exhausts it, key 2 is refused too), not a per-key limit |
| `validateRequest` | **enforced** | body checked against the operation's `requestBody` schema; `errorResponseCode` (422) for a non-conforming body, upstream not reached |
| `mockResponse` | **enforced** | configured code, body and headers, upstream not reached |
| `enforceTimeout` | **enforced** | 504 after `value` seconds (1 s limit answered in 1004 ms against a 3 s upstream) |
| `requestSizeLimit` | **enforced** | **400**, not 413, for a body over `value` bytes |
| `cache` | **enforced only with a prerequisite** | operation-level `cache` alone does nothing (3 calls = 3 upstream hits). With `middleware.global.cache.enabled: true` it works (3 calls = 1 hit); with `cacheAllSafeRequests: false` only operations that opt in are cached |
| the other 14 | **unverified** | accepted by the schema, not proven. `circuitBreaker` and `urlRewrite` were proven earlier on the synthetic catch-all only |

Matching, for what a specification does *not* describe:

- An **undeclared path is proxied** (200) unless allow-list mode is on. So declaring endpoints does not
  restrict anything by itself.
- A **method the spec does not declare is proxied** (`POST /plain` when only `GET /plain` exists).
- The listen path **without** its trailing slash (`/<slug>`) is not routed at all (404).
- Methods on one path are independent (`GET /multi` blocked, `POST /multi` proxied).
- **`{param}` matches exactly one path segment**, so `/{wildcard}` never matches `/a/b`, `/a/b/c` or the bare
  listen path (`/`). Regex templates (`/{wildcard:.*}`) are rejected by the gateway
  (`must define exactly all path parameters`); a schema `pattern` on the parameter changes nothing.
- A **real operation wins over a templated one at every depth** (`/orders/{id}` blocked beats `/{a}/{b}`).
- **A trailing slash is a different route.** A `block` on `/blocked` does **not** apply to `/blocked/`
  (200), and a block on `/tpl/{id}` does not apply to `/tpl/5/`. Corrected 2026-09-25: the OAS-02 check
  that claimed "a trailing slash on a declared path still matches" used an undecorated path, where 200 is
  the answer whether or not the route matched, so it proved nothing. Declaring the twin (`/blocked/`) closes it.

## Bypasses of a blocked endpoint, measured (OAS-03 probe, local runtime, 5.15.0)

Requests for an endpoint that has `block` (`GET /blocked`, `GET /tpl/{id}`):

| Request | Status | Closed by |
|---|---|---|
| exact path | 403 | — |
| `/blocked/` (trailing slash) | **200** | declaring the trailing-slash twin |
| `/BLOCKED`, `/TPL/5` (case) | **200** | `middleware.global.ignoreCase.enabled: true` (with the twins: 403) |
| `/blocked;a=b` (path parameter) | **200** | **nothing in open mode.** Allow-list mode answers 403 for anything undeclared |
| `//blocked`, `/./blocked` | 301 to the cleaned path | the gateway normalises and redirects |
| `/%62locked` (percent-encoded) | 403 | the gateway decodes before matching |
| `/blocked?x=1` | 403 | — |

So in **open mode** (the default) a per-endpoint control is a control on the path as the spec spells it, plus
its trailing-slash and case variants; `;param` variants still pass. **Allow-list mode is the hard boundary.**

## Behaviours the mapper must respect

1. **A real operation wins over a templated catch-all.** So once an API declares real operations, API-wide
   settings that the mapper hosts on catch-alls (circuit breaker, URL rewrite, mock, body transforms, request
   validation) no longer reach them and must be copied onto every real operation.
2. **The catch-all is a family, not one path.** Because `{param}` is one segment and a trailing slash is a
   different route, `mapToTykOas` emits a catch-all for the bare path and for 1 to 8 segments, each with a
   trailing-slash twin (`(2 * 8 + 1) * 5` operations). This fixes what the roadmap parked as "the bare
   listen path defect", which was in fact wider: an API-wide breaker, rewrite, mock or transform reached
   single-segment paths only. **Ceiling:** an undeclared path 9 or more segments deep still skips them
   (the e2e asserts that too); classic definitions use the regex `/.*` and have no such limit.
3. `cache` needs the API-level switch (above).
4. `rateLimit` is shared by all consumers (above); a UI must say so.

## Not proven here

Read-back fidelity of `middleware.operations` was measured for `block` only (identical); the other controls
are measured in the OAS-03 governance e2e. Only the OAS definition format (this product's default) was probed, not classic; a single gateway node, not
three; a keyless API for every control except `ignoreAuthentication` and the rate-limit scope test;
behaviour under load; `rateLimit` windows outside 10 s to 3600 s (per 10, 30, 60 and 3600 s are exercised in the governance e2e); and the 14 unverified controls.

## Where these controls are offered

OAS-03 exposes exactly the enforced controls through `PATCH /apis/:id/endpoints`; the control-to-field map is
`CONTROL_TYK_FIELD` in `endpoint-capabilities.ts`, and a unit test fails if the mapper emits a field that is
not offerable here. See [OAS-ENDPOINT-GOVERNANCE.md](OAS-ENDPOINT-GOVERNANCE.md).

## How it was run

Inside the api container (like the other `.mjs` e2e scripts), through the repo's own `TykClientService` and
`mapToTykOas`, against a local upstream on `:9911`. It creates seven throwaway OAS APIs
(`og-probe-oas02-<run>-*`) and three keys on the running gateway, bypasses Postgres (no `ApiDefinition`
rows, so reconcile never sees them), and removes everything in `finally`; the last step checks that each
API answers 404 again. It never prints the gateway secret.
