# What Tyk OSS 5.15.0 enforces per OpenAPI operation

Measured 2026-09-25 (OAS-02) on `tykio/tyk-gateway:v5.15.0`
(`sha256:0c8fcb5784b5d4960ee2609be655d22fd3cd1aaaba569cd2211901c85b8443d3`), the image this stack runs.
The evidence is executable: `pnpm --filter @open-gateway/api test:e2e:oas-capabilities` (32 checks) and
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
- A **trailing slash** on a declared path still matches. The listen path **without** its trailing slash
  (`/<slug>`) is not routed at all (404).
- Methods on one path are independent (`GET /multi` blocked, `POST /multi` proxied).
- The **operations subtree read back** from `GET /tyk/apis/oas/{id}` is **byte-identical** to what was
  pushed, so a desired-versus-effective comparison of `middleware.operations` needs no normalisation.

## Four behaviours the mapper must respect

1. **A real operation wins over the synthetic `/{wildcard}` catch-all.** With `GET /{wildcard}` mocked and
   `GET /orders` declared, `/orders` is *not* mocked while `/something` is. So once an API declares real
   operations, API-wide settings that the mapper hosts on the catch-all (circuit breaker, URL rewrite,
   mock, body transforms, request validation) **no longer reach them** and must be copied onto every real
   operation.
2. **The parked "bare listen path" defect is confirmed on 5.15.0.** `GET <listenPath>/` does not match
   `/{wildcard}` (proxied, mock skipped). A declared `GET /` operation **does** match it (blocked with 403),
   so the fix is to declare `/` alongside the catch-all.
3. `cache` needs the API-level switch (above).
4. `rateLimit` is shared by all consumers (above); a UI must say so.

## Not proven here

Only the OAS definition format (this product's default) was probed, not classic; a single gateway node, not
three; a keyless API for every control except `ignoreAuthentication` and the rate-limit scope test;
behaviour under load; `rateLimit` windows other than `60s`; and the 14 unverified controls.

## How it was run

Inside the api container (like the other `.mjs` e2e scripts), through the repo's own `TykClientService` and
`mapToTykOas`, against a local upstream on `:9911`. It creates seven throwaway OAS APIs
(`og-probe-oas02-<run>-*`) and three keys on the running gateway, bypasses Postgres (no `ApiDefinition`
rows, so reconcile never sees them), and removes everything in `finally`; the last step checks that each
API answers 404 again. It never prints the gateway secret.
