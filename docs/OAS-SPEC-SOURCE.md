# OpenAPI from a URL: watch it, propose new versions (OAS-08b)

An API's OpenAPI document can be imported from a URL and then **watched**: the URL is checked on a
schedule and on demand, every different document it serves is kept as a **candidate**, the user is
told ("update available"), and a human decides — apply it (the OAS-04 apply, nothing else) or dismiss
it. Nothing changes on the gateway until someone applies a version.

The fetch itself — address policy, allow-list, pinning, redirects, limits — is OAS-08a,
[OAS-SPEC-FETCH.md](OAS-SPEC-FETCH.md). This page is what happens around it. Plan:
`.omc/plans/ralplan-openapi-url-source.md` (REV 2 is authoritative); contract:
`.omc/handoffs/oas08-contract.md` §2 + REV 2.

## Routes

Existing permissions only. Tenant from the session; another tenant's API or candidate is **404**.
Every answer is `{ success, data }`.

| Route | Permission | Audited | Result |
|---|---|---|---|
| `GET /apis/:id/spec-source` | `api:read` | – | `{ configured:false }` or the source with its URL **redacted** (`https://host/…`) and the last check |
| `PUT /apis/:id/spec-source` | `api:update` | `UPDATED` | body `{ url?, intervalMinutes ∈ {15,60,360,1440}, enabled? }`; `url` required only on creation |
| `DELETE /apis/:id/spec-source` | `api:update` | `UPDATED` | `{ removed:true }`; a pending proposal is withdrawn (SUPERSEDED) |
| `POST /apis/:id/spec-source/check` | `api:update` | – (a change writes `SPEC_UPDATE_DETECTED`) | `{ result, errorCode?, candidate? }`; **429** `SPEC_CHECK_COOLDOWN` within 30 s of the last check; **409** `SPEC_SOURCE_CHANGED` when the URL was edited during the check |
| `GET /apis/:id/spec-candidates` | `api:read` | – | `{ pending: Candidate \| null, history: CandidateSummary[] }` (≤ 20) |
| `GET /apis/:id/spec-candidates/:cid/diff` | `api:read` | – | the OAS-04 dry run of the candidate against the **current** version; its `versionNo` is what the apply sends |
| `POST /apis/:id/spec-candidates/:cid/apply?expectedVersion=N[&acknowledgeRemoved=true]` | `api:update` | `UPDATED` | the OAS-04 result; candidate marked APPLIED in the same transaction |
| `POST /apis/:id/spec-candidates/:cid/dismiss` | `api:update` | `UPDATED` | `{ state:'DISMISSED' }` |
| `GET /spec-updates` | `api:read` | – | `{ items:[{ apiId, apiName, candidateId, detectedAt, diff }] }`, pending only, ≤ 100 |
| `POST /apis/import/url/preview` | `api:create` | – | JSON body `{ url, slug?, serverIndex? }`; same answer as `/apis/import/preview` |
| `POST /apis/import/url` | `api:create` | `CREATED` | JSON body `{ url, slug?, serverIndex?, watch?, intervalMinutes? }`; the import result plus `source` (null unless `watch`) |

`GET /apis` rows carry `specUpdateAvailable: boolean` (one query for the page, no N+1).

Error codes, each translated by the web app (the server's `message` is never the main text):
`SPEC_FETCH_<CODE>` (422 from the URL routes, or `lastErrorCode` of a check: `BAD_URL`,
`BLOCKED_TARGET`, `UNREACHABLE`, `TIMEOUT`, `TOO_LARGE`, `TOO_MANY_REDIRECTS`, `HTTP_<status>`),
`NOT_A_SPEC` (the document failed the OAS-04 gates), `CHECK_FAILED` (`lastErrorCode` only: the check
failed for another reason — a version applied mid-check, a lint crash, the database), `SPEC_CHECK_COOLDOWN` (429),
`SPEC_SOURCE_CHANGED` (409: the URL was edited while it was being checked — check again),
`CANDIDATE_STALE` (409: no longer pending — check again), `SPEC_SOURCE_LIMIT` (400: 50 sources per
tenant), `SPEC_SOURCE_URL_REQUIRED` (400), and OAS-04's `SPEC_VERSION_STALE`,
`SPEC_REMOVES_GOVERNED_ENDPOINTS`, `SPEC_GOVERNANCE_CHANGED` on apply. A URL with userinfo
(`user:pw@`) is refused (`SPEC_FETCH_BAD_URL`): Basic-auth-protected specs are unsupported; a secret
in the query string is the supported way.

**The URL is normalised** to the form the fetcher reads (`new URL(raw).href`: trimmed, `https:host` →
`https://host/`, backslashes → slashes, lower-case scheme and host) before it is validated, stored or
compared, so two spellings of one URL are one URL (no reset of what was learnt). Booleans in the JSON
bodies (`enabled`, `watch`) must be JSON booleans: the global pipe's implicit conversion would read
the string `"false"` as `true`.

## Data

Migration `20261003000000_spec_sources` (hand-written, idempotent, additive; Pump tables untouched).

- `api_spec_sources`: one per API (unique `api_def_id`, cascade from API and tenant). `next_check_at`,
  `last_checked_at`, `last_success_at`, `last_result` (`UNCHANGED|CHANGED|ERROR`), `last_error_code`
  (a fixed code, never remote text), `etag`, `last_modified`, `consecutive_failures`.
- `spec_candidates`: `content_hash`, `format`, `openapi_version`, `source_text` (**nullable: kept only
  while PENDING**), `endpoint_count`, `base_version_no` (display only), `diff_summary` (counts at
  detection), `findings` (warnings), `state` (`SpecCandidateState`: `PENDING APPLIED DISMISSED
  SUPERSEDED`), `detected_at`, `decided_at`, `decided_by`. Index `(api_def_id, content_hash)` is
  **not unique** (see A→B→A). The newest 20 rows per API are kept.
- `AuditAction.SPEC_UPDATE_DETECTED`: written by detection with the tenant and **no user, no
  correlation id** (a system event).

`api_specs` is unchanged: a candidate becomes a version only through the OAS-04 apply.

## Detection (one check)

1. **Claim.** The source row is claimed before any network call: `updateMany where { id,
   next_check_at = <the value read> }` (the scheduler) or `where { id, last_checked_at ≤ now − 30 s }`
   ("check now"), both setting `last_checked_at = now` and `next_check_at = now + interval + jitter`
   (≤ 10 % of the interval, ≤ 5 min). "Due" and the cooldown use the **database clock**
   (`SELECT now()`), shared by every replica. 0 rows claimed = someone else has it (skipped / 429).
   A crash or timeout mid-check leaves `next_check_at` advanced: retried at the next interval.
2. **Fetch** with the stored ETag / Last-Modified. `304` → `UNCHANGED`. A fetch refusal → `ERROR
   SPEC_FETCH_<CODE>`.
3. **Classify** the document (`SpecCandidateService.detect`):
   - hash = the latest `api_specs` hash → `UNCHANGED`, a PENDING proposal is SUPERSEDED (the URL
     reverted, or the version was uploaded by hand);
   - hash of a PENDING candidate → `CHANGED` with that candidate (the update is still waiting; a 304
     while a proposal waits answers the same, so `last_result` does not flip to `UNCHANGED`);
   - hash of a DISMISSED candidate → `UNCHANGED` and silent (a dismissal lasts until the content
     changes), any other PENDING is SUPERSEDED;
   - otherwise the OAS-04 dry run (`SpecUpdateService.update(…, { dryRun:true, expectedVersion:
     latest })`: 5 MB, alias guard, external `$ref`, lint, 3.x, 5000 operations). A refusal or a lint
     error → `ERROR NOT_A_SPEC`, never a candidate. Else, in one transaction that locks the source row
     (`SELECT id, url … FOR UPDATE`): refuse if the URL is no longer the one fetched (an edit landed
     mid-check: `SPEC_SOURCE_CHANGED`, nothing stored or audited); re-read the latest version and stop
     (`UNCHANGED`) if this content was applied meanwhile; supersede the old PENDING, insert the new one
     — or, for content seen before as APPLIED/SUPERSEDED, reset that row to PENDING (A→B→A) — and trim
     to 20 rows. Then one `SPEC_UPDATE_DETECTED` audit row → `CHANGED`. Every timestamp (`detected_at`
     on a reset, `decided_at`, `last_success_at`, the claim) is the database clock.
   - Any other failure (not a fetch refusal) is recorded as `ERROR CHECK_FAILED` with the same backoff;
     the log line carries the error's name only.
4. **Record** on the source: result, fixed error code, failures. The ETag / Last-Modified are stored
   **only when the gates passed** (after `NOT_A_SPEC` the old ones stay, so the next check re-fetches
   and a 304 cannot mask the error). The write is guarded on the URL: an edit that changed it during
   the check does not inherit the answer. A source or API that vanished meanwhile is dropped.

Consecutive failures back off: next check `interval × 2^(failures−1)`, capped at 24 h.

`PUT` makes the source due now ONLY when the URL changes or `enabled` goes false → true: a no-op PUT
must not bypass the 30 s cooldown (or start a second check of a source being checked). A PENDING row
whose content IS the latest version (uploaded by hand) is set SUPERSEDED, text dropped, when the
candidates are listed and on a 304 (a 304 never reaches detection).

**At most one PENDING per API** comes from the claim plus the row lock in the insert transaction, not
from a partial unique index (Prisma cannot model one and `migrate diff` would drift).

**Pending is derived at read time**: a candidate is shown only while `state = 'PENDING'` **and** its
hash differs from the latest `api_specs` hash (`pendingSpecCandidates` in `api.service.ts`, one SQL
query). A manual upload of the same bytes makes the banner vanish without touching the row.

## Apply

The diff route re-runs the OAS-04 dry run against the **current** latest version (never the stored
`diff_summary`: governance or the spec may have moved). The apply requires `expectedVersion` = the
`versionNo` that diff returned; if the API moved on, 409 `SPEC_VERSION_STALE` → the client re-diffs.
`SpecUpdateService.update` gained an optional `onApplied(tx)` hook: the candidate is marked APPLIED
**inside** the OAS-04 transaction, and if it is no longer PENDING (dismissed, superseded meanwhile) the
hook throws `CANDIDATE_STALE` and the new version rolls back. An apply the OAS-04 rules refuse
(`SPEC_REMOVES_GOVERNED_ENDPOINTS`, lint, stale) leaves the candidate PENDING. `SpecUpdateResult`
gained `document: { contentHash, format, openapiVersion, endpointCount }` (additive) so detection
stores a candidate without linting twice.

## Scheduler

`SpecSourceScheduler`, `@Interval(60 s)`, in `api-import`. An in-process `running` flag skips a tick
while the previous one runs; a **45 s budget** per tick (what it does not reach stays due); due rows
(≤ 200, oldest first) are interleaved **round-robin per tenant**, and each tenant may use at most
`max(1/2, 1/#tenants due)` of the budget (all of it when it is alone; checked before a check starts, so
a tenant overruns its share by at most one check). Round-robin alone shares by count: one tenant with
many slow-but-OK sources would otherwise take most of every tick. Cross-replica safety is the claim,
not the flag. Gauge `og_spec_source_oldest_overdue_seconds` (no labels) on `/api/metrics`: how long
the most overdue enabled source has waited (0 when none is due).

**Throughput ceiling (one replica).** Checks run one after another: ≤ 45 s of checking per minute. A
304 or a small document costs well under a second; the worst case (10 s fetch deadline, or a 5 MB lint)
is 4–5 checks per tick. At that worst case the 50 sources of one tenant at 15 min (3.3 checks/min) are
already beyond what one replica sustains. "Check now" shares the fetcher's 2 concurrent slots with the
scheduler. Spectral runs synchronously in-process on up to 5 MB: one such check can hold the event loop
for seconds; the budget bounds a tick, not a single lint.

**Recommended alert** (not added — `infra/` is the lead's): `og_spec_source_oldest_overdue_seconds >
900 for 15m` (warning): the scheduler is not keeping up (or not running). It needs an owner and a
runbook before it is wired, like the other rules.

## Secrets in the URL

The URL may carry a secret (`?token=…`). It is stored plain (like webhook receiver URLs: there is no
secret store), returned only redacted, never logged (log lines name the source id; errors carry fixed
codes and messages). The audit interceptor stores PUT/PATCH bodies, and its redaction matched key
names only. It now reads every string with the same `new URL()` the fetcher uses (so ` https://…`,
`\thttps://…`, `https:host/…`, `https:\\host\…`, `HTTPS://…` and tabs inside the scheme are URLs to it,
as they are to the fetcher), for a whole value (≤ 2048 chars) and for URLs embedded in longer text:
- on `PUT /apis/:id/spec-source` and `/apis/import/url*` only the **origin** is kept (`https://host/…`):
  a spec URL's path can carry the secret too;
- on every other route userinfo, query and fragment are stripped and the **path is kept** (e.g.
  `proxyUrl`, whose path is configuration);
- in a 5xx error message every URL becomes `[URL]`.
The URL-import routes are POSTs: their body is not stored at all.

## Evidence (2026-09-25)

| Claim | Kind | Where |
|---|---|---|
| Migration deploys after all others, re-applies as a no-op, `migrate diff` clean (and failing with the table dropped) | throwaway Postgres 16 | lane B report |
| Claim CAS (two claimers, one fetch), manual + scheduled at once, row lock (two contents → one PENDING), DB-clock cooldown, detection matrix incl. NOT_A_SPEC keeps the ETag, A→B→A, apply after a manual upload (409 → re-diff → apply), APPLIED inside the transaction and rolled back when decided meanwhile, derived pending, retention 20 + text only while PENDING, source removed → superseded, 50 cap, tenant isolation on both tables | throwaway Postgres 16, fake fetcher port | `services/spec-source.db-spec.ts` |
| Detection matrix, backoff, claim-before-fetch, URL-guarded write, cooldown, cap, url-optional edit + reset, error mapping, no URL in logs | unit, mocked Prisma + fake port | `services/spec-source.service.spec.ts`, `services/spec-candidate.service.spec.ts` |
| Running guard, time budget, fairness, gauge | unit | `services/spec-source.scheduler.spec.ts` |
| Permissions and audit flags of every route | static (metadata) | `controllers/spec-source-controllers.spec.ts`, `controllers/api-import-controllers.spec.ts` |
| `?token=` absent from the stored audit details; no URL from a 5xx message | unit (shown failing first) | `audit/interceptors/audit-log.interceptor.spec.ts` |
| PUT through the real ValidationPipe (unknown field, interval 61, "60" → 60, 2049-char url, `"false"`) and the real audit interceptor (four URL spellings: origin only) | HTTP, service doubles | `controllers/spec-source.http.spec.ts` |
| Review fixes M1 (URL edited mid-check), LOW 1 (applied meanwhile), LOW 3 (no-op PUT), H1 normalisation, LOW 2 (DB clock) | throwaway Postgres 16 | `services/spec-source.db-spec.ts` |
| Live: import from URL + watch, 304, cooldown, change → candidate → apply → gateway sync, dismiss, NOT_A_SPEC, blocked target, other tenant 404 | **live, deployed build: 38/38** (run by the lead, 2026-09-25) | `apps/api/test/e2e/oas-spec-source.e2e.mjs` |
| HTTP as the seeded admin through the edge (guards, pipes, interceptor) | **live, deployed build: 28/28** (run by the lead, 2026-09-25) — a scratch script, **not in the repo**, so not re-runnable from here | lead's session notes |

## Known limits

- The 50-sources cap is count-then-insert: two concurrent creations can overshoot by one.
- A version applied between detection's read and its dry run makes that check throw (logged by id,
  `next_check_at` already advanced): it is retried at the next interval rather than recorded.
- The URL-import routes create the API, then the source: a source insert failing after the import
  (a race past the cap check) leaves the API without a watcher; add one with `PUT …/spec-source`.
- The committed e2e drives the controller classes directly: guards, pipes, the audit interceptor and
  pino are not exercised by it (the pipe and the interceptor are exercised over HTTP in
  `controllers/spec-source.http.spec.ts`, with service doubles). The live HTTP proof as the seeded
  admin (28/28) was a scratch script and is not committed: it cannot be re-run from the repo.
- Tenant 404 coverage: the live e2e calls five handlers with a real second tenant (`GET spec-source`,
  `GET spec-candidates`, `POST …/check`, `POST …/dismiss`, `DELETE spec-source`) and checks that
  `GET /spec-updates` of that tenant excludes the API. `PUT`, `…/diff` and `…/apply` are covered for
  another tenant at the service level only (`services/spec-source.db-spec.ts`, real Postgres).
- The audit origin-only mode is chosen from the request path (`/spec-source`, `/import/url`,
  `/import/url/preview`; case-insensitive, optional trailing slash), not from the handler's `@Audit`
  metadata: a new route that carries a spec URL must be added to that pattern.
- No outbound notification (webhook/email): in-app only (owner decision Q2a).
