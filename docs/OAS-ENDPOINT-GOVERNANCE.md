# Endpoint governance (OAS-03)

Govern the endpoints of an API imported from an OpenAPI document: block one, make it public, rate-limit,
cache, time out, cap its body, mock it, validate its request body, or switch the whole API to allow-list
mode (only the endpoints in the spec answer). Only controls the pinned gateway was **proven** to enforce
are offered ([OAS-ENDPOINT-CAPABILITIES.md](OAS-ENDPOINT-CAPABILITIES.md)).

## Routes

Both under `apis`, guarded by `TenantIsolationGuard` + `PermissionsGuard`; tenant id from the session only;
another tenant's API is **404**. No new permission codes.

| Route | Permission | Notes |
|---|---|---|
| `GET /apis/:id/endpoints` | `api:read` | Spec summary, `endpoints` (index row + `governance` or `null`), `orphans`, `restrictToSpec`, `revision`, `syncStatus`/`syncError`, `capabilities`. 404 without a stored spec. |
| `PATCH /apis/:id/endpoints` | `api:update`, audited `api:updated` | Body below. Answers the same payload as GET with the fresh `revision`. |

```jsonc
{
  "expectedRevision": "<64 hex from GET>",     // required; stale -> 409 ENDPOINT_REVISION_STALE
  "keys": ["getOrder"],                         // 1..500 endpoint keys of the latest spec, or
  "tag": "orders",                              // every endpoint with this tag (exactly one of keys/tag with set/clear)
  "set": { "enabled": false, "auth": "public", "rateLimit": { "rate": 2, "per": 10 },
           "cache": { "timeoutSeconds": 60 }, "timeoutSeconds": 1, "requestSizeLimitBytes": 1024,
           "mock": { "code": 200, "body": "{}" }, "validateRequestSchema": { "type": "object" } },
  "clear": ["rateLimit"],                       // or "enabled": true / "auth": "inherit" to clear those two
  "restrictToSpec": true,                       // allow-list mode (API-level)
  "dropOrphans": true                           // remove governance of keys no longer in the spec
}
```

Refused with **400**: unknown fields or controls, unknown keys (named), a tag nobody carries, `cache` on a
non-GET endpoint, `validateRequestSchema` on anything but POST/PUT/PATCH, or containing `$ref`, `$id`,
`$anchor`, `$dynamicRef`, `$dynamicAnchor`, `$schema` or a `type` array, or deeper than 64 levels / over
64 KB; per-endpoint cache while the API has an API-wide `config.cache` (and `PATCH /apis/:id` refuses an
API-wide cache while an endpoint has one); more than 1000 governed endpoints; more than **1 MiB**
(`MAX_GOVERNANCE_BYTES`) of stored governance in total (one 64 KB schema set on 500 endpoints is refused);
two governed endpoints that route the same (same method and the same path up to parameter names and letter
case, e.g. `/Admin` vs `/admin`, `/a/{x}` vs `/a/{y}`; both keys named); a governed endpoint whose path
template the gateway cannot take (empty `{}`, repeated or unbalanced parameters, `:` `?` `#`, `{{`/`}}`);
allow-list mode on a spec with no endpoints or more than 1000; a classic-format or TCP API; an API with no
stored spec. `PATCH /apis/:id` also refuses a `protocol` change on an API that governs endpoints. Header
names in mocks (and in the API-wide header transforms) must be RFC 7230 tokens and values may not contain
CR, LF or NUL.

## Storage and concurrency

Governance lives in `ApiDefinition.config.endpoints` (keyed by endpoint key) and `config.restrictToSpec`,
stored normalised (no-op values and empty entries are never stored). They are **not** fields of
`ApiConfigDto`, so `PATCH /apis/:id` cannot write them (400) and its section-wise merge keeps them.

The write is one statement: `UPDATE … WHERE id AND tenant_id AND config = <config read>` (jsonb equality),
which also sets `syncStatus = PENDING`. Zero rows → 409. The revision is `sha256` of the key-sorted JSON of
`{ endpoints, restrictToSpec, specVersion }` (the latest spec `versionNo`), so `keys` and `dropOrphans` refer
to the index the caller saw: a spec re-upload makes an older revision 409. `cacheResponseCodes` are stored
sorted and de-duplicated, so equal behaviour has an equal revision.

Syncs of one API run one after another (an in-process chain per API), each re-reading the row first, so two
quick PATCHes cannot leave the gateway on the older config while the row says `SYNCED`. **Per process only**:
two API replicas can still interleave (an advisory lock or an outbox worker is the upgrade). No transaction is open while the gateway is called; the sync that follows is
the normal background one.

## What reaches the gateway

`mapToTykOas(apiDef, tenant, jwtSource, versions, endpointRefs)` — the new last argument is the stored spec
index, loaded (tenant-scoped, `endpointIndex` only) **only** when the API governs something; otherwise the
output is byte-for-byte what it was before (unit-tested).

- A real operation `og_ep<n>` per governed endpoint (every endpoint in allow-list mode), with its
  trailing-slash twin `og_ep<n>_s` (G2) and path parameters declared; spec operationIds never reach the document.
- `middleware.global.ignoreCase` on (G3). Per-endpoint cache adds
  `middleware.global.cache { enabled, timeout: 60, cacheAllSafeRequests: false }` so only opted-in endpoints cache.
- API-wide per-operation middleware (breaker, rewrite, mock, body transforms, validation) is copied onto
  every real operation, the endpoint's own value winning (G5).
- Open mode keeps the catch-all family for undeclared paths, merged into a real path item of the same
  routing shape (`/{id}` vs `/{wildcard}`); allow-list mode emits no catch-alls.
- Orphans (keys no longer in the spec) are never emitted.

After the push, **every node is read back** and compared with subset semantics (defaults Tyk adds are
ignored): the middleware of every `og_ep*` operation, its `operationId` at `paths[path][method]`, and the
`ignoreCase`/`cache` global keys that were sent. Two gateway normalisations are measured (5.15.0) and
accepted: `rateLimit.per` is stored canonicalised (`60s` -> `1m`, `90s` -> `1m30s`, `3600s` -> `1h`,
`86400s` -> `24h`; that one field is compared as a duration), and an empty value (`mockResponse.body: ''`)
is omitted (an absent key equals a sent `''` or `[]`). Measured identical: block, allow,
ignoreAuthentication, cache, enforceTimeout, requestSizeLimit, validateRequest, mock with body and headers,
rateLimit `30s`. A node that does not report them as sent is `ok:false`, so
the row is `FAILED` ("… do not report it as sent"), never `SYNCED` from the write alone. Allow-list mode with
an empty index — or nothing the mapper can emit — fails closed (`FAILED`, nothing pushed); two endpoints
that route the same also make the sync `FAILED` with both keys named (and a debug request 400). `POST /apis/:id/debug` renders the same governed definition.

## Security notes (what open mode does not close)

Open mode applies a control to the path as spelled, plus its trailing-slash and case variants. A path
parameter (`/blocked;a=b`) still bypasses a block (G4). **Allow-list mode is the hard boundary**: anything
undeclared — path, method, `HEAD` on a path that does not declare it, `;a=b` — answers 403, while CORS
preflights are still answered. A per-endpoint `rateLimit` is **one counter shared by all consumers**.

## Evidence

| Claim | Kind | Where |
|---|---|---|
| Model: normalisation, revision, targeting, method rules, cache conflict, `$ref`/depth/size, orphans, caps, `__proto__` keys | unit | `endpoint-governance.spec.ts` |
| Mapper: every control's Tyk field; only offerable fields emitted; twins, ignoreCase, allow-list, API-wide copy, family merge, ordering, no duplicate shapes; unchanged output without governance; read-back subset | unit | `endpoint-governance-mapper.spec.ts`, `endpoint-capabilities.spec.ts` |
| DTO bounds and unknown fields; `PATCH /apis/:id` cannot write governance; header-injection refusals | unit (real ValidationPipe) | `update-endpoints.dto.spec.ts` |
| Without governance the output equals a golden produced by the COMMITTED mapper (`8ec2fe5`), for 3 configs incl. API-wide mock, breaker and cache | unit (golden from a commit) | `tyk-oas-mapper.golden.spec.ts` |
| Audit rows: a deeply nested body is cut at depth 32 without a stack overflow; a body over 16 KB is stored as a marked preview | unit | `audit-log.interceptor.spec.ts` |
| Per-API sync serialisation (newest config lands last; stale snapshot re-read; a failure does not wedge the chain) | unit (fake client) | `api.service.governance.spec.ts` |
| Service: tenant-scoped queries, 404/400/409 paths; ApiService: refs only when governed, per-node read-back → FAILED, fail-closed, debug, CAS, cache guard | unit (mocked Prisma/Tyk) | `endpoint-governance.service.spec.ts`, `api.service.governance.spec.ts` |
| Concurrent same-revision writers → exactly one wins, the other 409; jsonb key order does not cause false 409s; tenant B cannot read/write/CAS; section merge keeps governance; `PATCH /apis/:id` racing a governance write keeps it; CONTROL: the same race through an unguarded read-modify-write loses it | **real Postgres 16, throwaway container** (never the stack DB), fake gateway | `apps/api/src/modules/api-management/services/endpoint-governance.db-spec.ts` (7/7; run recipe in its header; refuses to run unless `DATABASE_URL` equals `OG_THROWAWAY_DATABASE_URL`). During OAS-03 the race tests were also shown failing with the compare-and-set guard removed from the code |
| Everything on the live gateway through the real sync path (block + variants, allow-list, preflight, HEAD, auth public, rate limit with a 10 s window, timeout, size, mock, validation POST/PUT, cache, API-wide mock on a real op, family in open mode, read-back of a hand-edited node → FAILED then repair, concurrency, tenant 404, classic refused, orphans) | local runtime, pinned Tyk OSS 5.15.0 | `apps/api/test/e2e/oas-endpoint-governance.e2e.mjs` — **61/61** on the rebuilt api (incl. rate limits per 10/60/3600 s SYNCED and a control-API check that no node keeps a probe definition). Earlier runs found two read-back normalisations (canonicalised `per`, omitted `false`), both fixed and pinned by unit tests |
| The routes over HTTP as the seeded admin: guards, ValidationPipe, 401/400/409, `per: 60` → SYNCED | local runtime (HTTP) | lead's HTTP-level proof, **24/24** |

## Limits

- Read-back runs at sync time. A hand edit made on a node **after** a successful sync is not compared
  against Postgres until the next sync; only the existing node-versus-node drift sees it (and only with
  more than one node).
- The e2e's read-back check injects the hand edit between push and read-back (a wrapped client); it proves
  the comparison and the FAILED path on the live gateway, not an operator racing a sync.
- `PATCH /apis/:id` with a `config` section also writes by compare-and-set: when a governance write lands
  between its read and its write, it re-reads, re-merges its own sections and retries once, then answers
  409 `API_CONFIG_CHANGED`. It never silently overwrites governance (real-Postgres proof; shown failing
  without the guard). Its other checks (JWT section, certificate ownership) run against the first read.
- A spec with path templates the gateway rejects makes the sync `FAILED` with a sanitised error.
- Operation ids are positions in the stored index: they change when a spec update reorders endpoints (the
  next sync rewrites them all; nothing stores them).
