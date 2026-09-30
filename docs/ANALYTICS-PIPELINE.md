# Analytics Pipeline (Tyk Pump → Postgres)

> How request metrics reach the dashboard, what the pump's tables actually contain, and the two
> counter traps that silently produce wrong numbers.

The open-source Tyk Gateway has **no analytics API** (`GET <gateway>/analytics` is a Tyk Dashboard
feature). Instead the gateway buffers analytics records in Redis and **Tyk Pump** purges them into
PostgreSQL, where the NestJS API reads them with tenant-scoped SQL.

## Pipeline

```
client ──► Tyk Gateway :33005 (data plane; control API on :8081, not published) ──► upstream
                │  ENABLEANALYTICS=true, ANALYTICSCONFIG_TYPE="" (buffer in Redis)
                ▼
          Redis :33003  (records, TTL 3600s)
                │  tyk-pump, purge_delay 10s, purge_chunk 1000
                ▼
          PostgreSQL :33002 (127.0.0.1)   tyk_analytics (raw)  +  tyk_aggregated (hourly rollup)
                │  prisma.$queryRaw, scoped to the tenant's tykApiId set
                ▼
          NestJS /api/analytics/*  ──►  Next.js /analytics
```

| Component | Pin | Why |
|---|---|---|
| `tykio/tyk-gateway` | `v5.15.0` | `:latest` resolves to a stale 2021 v3.0.4 locally |
| `tykio/tyk-pump-docker-pub` | `v1.17.0` | Same release train as the gateway; supports PostgreSQL 13–17 |

Both images are **distroless** (uid 65532, no shell, no `wget`/`curl`), which has two consequences
encoded in `infra/docker-compose.yml`:

- **No compose healthchecks** for the gateway or the pump — there is no binary in the image to run one.
  Dependents use `condition: service_started`; the API degrades gracefully (circuit breaker,
  `syncStatus=FAILED`, `POST /apis/:id/sync` retry, `GET /gateway/status`). The pump's own HTTP
  `/health` endpoint is probed by the API instead — see [Pump liveness](#pump-liveness).
- **`tyk-gateway-init`** (`alpine:3`, one-shot) chowns the `tyk_apps` volume to `65532` before the
  gateway starts. Without it `/opt/tyk-gateway/apps` stays `root:root` and every `POST /tyk/apis`
  fails with `{"status":"error","message":"file object creation failed, write error"}`.

## Pump configuration (`infra/pump/pump.conf`)

Mounted read-only at `/opt/tyk-pump/pump.conf`. A healthy start logs:

```
## Tyk Pump, 1.17.0 ##
Init Pump: POSTGRES
Init Pump: POSTGRESAGGREGATE
Starting purge loop @10, chunk size 1000
```

Load-bearing settings — do not "clean these up":

| Setting | Why |
|---|---|
| `dont_purge_uptime_data: true` | Defaults to `false`, which starts an uptime pump even with no uptime target. When it cannot reach a persistent DB **the whole pump process exits**, taking both Postgres pumps with it. |
| `storage_expiration_time: 3600` | With `purge_chunk` set and this unset the pump overrides the Redis TTL to 60 s. Matches the gateway's `STORAGEEXPIRATIONTIME`. |
| `omit_detailed_recording: true` | Drops `rawrequest`/`rawresponse` at the pump even if detailed recording is ever enabled — they hold full bodies (PII, unbounded growth). |
| `log_level: "info"` | The pump maps `debug`→Info, `info`→Warn; **`"error"` is unhandled and silently becomes `silent`**. |
| `health_check_endpoint_name` / `_port` (`"health"` / `8083`) | Serves `GET /health` → `200 {"status": "ok"}`. These are the pump's defaults, pinned explicitly because the API's liveness probe depends on them. The name has **no leading slash**; the port is not published to the host. |
| `table_sharding: false` | Sharding would create `tyk_analytics_YYYYMMDD` tables and break every query. |
| `track_all_paths: false` | Only populates the `endpoints`/`apiendpoints`/`keyendpoints` dimensions, which nothing queries, while multiplying aggregate rows per distinct path. |
| pump names `postgres` / `postgresaggregate` | `TYK_PMP_PUMPS_<NAME>_META_CONNECTIONSTRING` uses `_` as the path delimiter, so a name containing an underscore makes the override silently fail (`TYPE Env var for pump ... not found`). |

Both tables are created by the pump itself (gorm AutoMigrate) on its first purge. They are
deliberately **absent from `schema.prisma`** — Prisma would try to manage them — and are therefore
read exclusively through `prisma.$queryRaw` with bound parameters.

## Pump liveness

`pipelineReady` needs more than existing tables: after `docker stop tyk-pump` the tables and their
rows are still there, so the dashboard would show stale numbers with no warning. Data age cannot
tell "pump stopped" from "gateway idle" (an idle gateway also has old rows), so the API probes the
pump itself:

```
api ──GET PUMP_HEALTH_URL (http://tyk-pump:8083/health, 3 s timeout)──► tyk-pump   → 200 {"status": "ok"}
```

`PumpHealthService.isReachable()` never throws and is not circuit-broken. An unset `PUMP_HEALTH_URL`,
a network error, a timeout or a non-2xx answer all read as **not reachable**. The pump's port is not
published to the host, so an API running outside compose reports "pump not running" unless you publish
`8083` yourself and point `PUMP_HEALTH_URL` at `http://localhost:<that port>/health`. Ceiling: `/health` proves
the pump process is up, not that its purge loop is making progress.

`GET /api/analytics/health` returns `pumpReachable`, and `pipelineReady = both tables present AND
pumpReachable`. The UI treats the two failure shapes differently:

| State | UI |
|---|---|
| Tables missing, or pump down with no rows recorded | Full-page "Analytics pipeline not receiving data" state |
| Pump down, tables hold rows | Warning banner ("Tyk Pump is not running … last record N ago") **and** the existing data, shown as stale |

Proof (compose stack): `docker stop open-gateway-tyk-pump` → the next health call returns
`pumpReachable:false`; `docker start open-gateway-tyk-pump` → `true` again within seconds.

## `tyk_analytics` — raw, one row per request (52 columns)

| Column | Type | Notes |
|---|---|---|
| `timestamp` | timestamptz | Request time |
| `apiid` | text | Joins `ApiDefinition.tykApiId` — the tenant scope |
| `api_name`, `orgid` | text | From the API definition |
| `apikey` | text | murmur64 hash (= Tyk's `key_hash`, = `ApiKey.tykKeyId`); `00000000` = unauthenticated |
| `alias` | text | The key's alias (we set it to the key name) |
| `method`, `path`, `rawpath`, `originalpath`, `listenpath`, `host` | text | `path` is post-strip |
| `responsecode` | bigint | |
| `latency_total`, `latency_upstream`, `latency_gateway` | bigint | milliseconds |
| `day`, `month`, `year`, `hour` | bigint | Pre-bucketed |
| `rawrequest`, `rawresponse` | text | Empty unless detailed recording is on |
| `"expireAt"` | timestamptz | **camelCase — must be double-quoted in SQL** |

**This table has zero indexes.** The `sql` pump only creates indexes inside its
`table_sharding: true` code path, and we run with sharding off. The API therefore creates its own on
`AnalyticsModule` init (idempotent, guarded by `to_regclass`, see `pump-query.builder.ts`):

```
og_tyk_analytics_apiid_ts   (apiid, "timestamp" DESC)
og_tyk_analytics_ts         ("timestamp" DESC)
og_tyk_analytics_apikey_ts  (apikey, "timestamp" DESC)
og_tyk_analytics_captured_apiid_ts  (apiid, "timestamp" DESC) WHERE rawrequest <> '' OR rawresponse <> ''
```

The last one is partial: it holds only rows with a captured dump, so the traffic inspector's "has this
API ever been recorded" check does not walk every row of the API. Postgres uses it only when the
query filters on exactly `rawrequest <> '' OR rawresponse <> ''`.

Module init, not a Prisma migration: the pump may create the table *after* `migrate deploy` has run,
and an applied migration never re-runs. The daily retention cron (below) retries the same DDL, so a
table the pump creates after the API booted still gets its indexes and redaction trigger.

## `tyk_aggregated` — hourly rollup (48 columns)

`id text PK`, `timestamp` **bigint** (unix epoch, start of the hourly bucket), `org_id`, `dimension`,
`dimension_value`, the `counter_*` family, and per-code columns
(`code_1x, code_2x, code_200, code_201, code_3x, code_30x, code_4x, code_400, code_401, code_403,
code_404, code_429, code_5x, code_500..504`). The pump creates
`tyk_aggregated_idx_dimension (dimension, timestamp, org_id, dimension_value)`.

| `dimension` | `dimension_value` | Use |
|---|---|---|
| `apiid` | Tyk `api_id` | **Primary query** — per-API rollup, time series, status codes |
| `apikeys` | key murmur64 hash | Per-key rollup (`00000000` = unauthenticated, excluded) |
| `errors` | status code as text | **Never queried** — carries no `apiid`, so it cannot be tenant-scoped |
| `` (empty) | `total` | Org-wide total — **never queried**, one `org_id` is shared by all tenants |
| `endpoints`, `apiendpoints`, `keyendpoints`, `versions`, `tags` | | Not populated (`track_all_paths: false`) / unused |

### Trap 1 — `code_2x` and `code_200` are always 0

Only error codes are populated. Verified on one hour of probe traffic (8 requests: 5×200, 2×500, 1×401):

```
dimension_value | counter_hits | counter_success | counter_error | code_2x | code_200 | code_401 | code_500
probe-1         |            8 |               5 |             3 |       0 |        0 |        1 |        2
```

→ totals always come from `counter_hits` (all), `counter_success` (2xx), `counter_error` (non-2xx).
The `code_*` columns are used **only** for the error-code breakdown chart.

### Trap 2 — latency must be re-weighted

`counter_latency` is already a per-row average and cannot be averaged across rows:

```sql
SUM(counter_total_latency)::numeric / NULLIF(SUM(counter_hits), 0) AS avg_latency_ms
```

The same holds for `counter_total_upstream_latency`.

### Tenant scoping

Every query is constrained to the caller's `ApiDefinition.tykApiId` set (never by `org_id`, which is
a single global `org123` for all tenants). An empty set short-circuits to zeros **before** any SQL
runs. See `pump-query.builder.ts` — the builders are pure so this is unit-tested
(`pump-query.builder.spec.ts`, `analytics.service.spec.ts`).

The aggregate lower bound is the window start **floored to the hour**, because a row's `timestamp` is
the start of its hourly bucket.

## Endpoints

All require `analytics:read`; `range` ∈ `1h | 24h | 7d | 30d` (default `24h`).

| Endpoint | Source | Notes |
|---|---|---|
| `GET /api/analytics/overview` | aggregate + raw | Totals, `errorRate` as a **percentage 0-100**, avg + upstream latency, `p50`/`p95`/`p99` latency, active API/key counts |
| `GET /api/analytics/timeseries?metric=requests\|errors\|latency` | raw for `1h`, aggregate otherwise | Minute buckets for `1h`, hour for `24h`/`7d`, day for `30d`; all three series always returned; ≤ 750 buckets |
| `GET /api/analytics/apis` | aggregate | Per-API rollup, zero-filled for APIs without traffic |
| `GET /api/analytics/keys` | aggregate | Per-key rollup by `ApiKey.tykKeyId` |
| `GET /api/analytics/top-apis?limit=` | aggregate | `limit` ≤ 50 |
| `GET /api/analytics/status-codes` | aggregate | `dimension='apiid'` + `code_*`; 2xx from `counter_success` |
| `GET /api/analytics/health` | both + pump probe | `pipelineReady` (both tables exist **and** `pumpReachable`) + `pumpReachable` + `rawTablePresent` / `aggregateTablePresent` + tenant-scoped `rowCount` / `lastRecordAt` |
| `GET /api/analytics/export?format=csv` | raw | Requires `analytics:export` (403 without it), not `analytics:read`. Streams — writes each page to the response as it is fetched, never buffers the full CSV — capped at `ANALYTICS_EXPORT_MAX_ROWS` (50,000) rows |

`overview`'s `p50`/`p95`/`p99` (WP21) always read `tyk_analytics` (raw), **never** `tyk_aggregated`,
regardless of `range` — `percentile_cont` needs the underlying per-request distribution, and the
aggregate table only holds pre-summed `counter_*` values, which cannot be turned back into a
percentile. Bounded by the raw table's own retention (default 30d), which covers every `range` up
to `30d`.

`overview` and `top-apis` are cached in Redis for 60 s under `analytics:{tenantId}:{metric}:{range}`.
A missing pump table is not an error: reads log a warning and degrade to zeros so the dashboard can
show an "analytics pipeline not receiving data" hint.

## Redaction (WP21)

`omit_detailed_recording` (`infra/pump/pump.conf`) is `false` for the `postgres` pump: `rawrequest`/
`rawresponse` are populated (base64) for any API with `enable_detailed_recording` on. Live-verified
format: base64-encoded **plain HTTP text** — headers and body verbatim, e.g. decoding a captured row
gives `Authorization: Bearer <token>\r\n...\r\n\r\n{"password":"..."}`.

The pump (`tykio/tyk-pump-docker-pub`, a pulled binary) has no field-level redaction option, so this
is enforced one layer down: a Postgres `BEFORE INSERT` trigger (`og_redact_tyk_analytics_trg`,
created by `AnalyticsService.onModuleInit()` — see `pump-query.builder.ts`'s `analyticsRedactionDdl`)
decodes each row's `rawrequest`/`rawresponse`, replaces the **value** of `Authorization`, `Cookie`,
`Set-Cookie`, `X-Tyk-Authorization` and `X-Api-Key` headers with `[REDACTED]` (name kept, for
diagnostics), replaces configured JSON body field values (`ANALYTICS_REDACT_FIELDS`, comma-separated;
defaults to `password, pass, secret, token, authorization, api_key, apikey, credential, ssn,
credit_card, creditcard, cvv, access_token, refresh_token, client_secret`), then re-encodes — all
before the row becomes readable by anyone. A trigger fires for the pump's actual multi-row inserts
exactly as it would for a single plain one, and cannot be bypassed by a client that merely forgets to
redact.

Field keys match **exactly** (`token` does not cover `access_token`, hence the explicit OAuth
entries). A field's value is redacted when it is a JSON string (escape-aware: `"a\"b"` is one value)
or a JSON number; either becomes `"[REDACTED]"`. A field holding an object or array is redacted whole
when it is flat (string-aware, so a `}` inside a string does not end it); one nested deeper, which a
regex cannot match, is redacted from its opening bracket to the end of the dump (over-redacting the
tail is safe, leaving inner keys is not). Rows stored before this rule keep the old behaviour: the
backfill only runs when the trigger was missing. Form-encoded bodies and query-string secrets are not
covered here; the traffic inspector adds a second, display-time pass that redacts by name pattern in
headers, query/form parameters and JSON fields, and a secret-named key holding an object or array is
redacted whole at any depth (`http-dump-parser.ts`). A redacted key is written back as configured (`"Password" : 1` is stored as
`"password":"[REDACTED]"`).

Cost is bounded: each decoded dump is cut to its first 16,384 characters **before** any regex runs,
and a cut dump ends with the line `[TRUNCATED: capture cut at 16384 characters before redaction]`; a
secret cut open by the cap is still redacted. Postgres regex capture groups cost ~0.5 ms per match, so
the old single-pattern pass let a body of `"cvv":1,` repeated hold a single-row INSERT for ~11 s at
200 KB (and stall the pump for every tenant); measured on Postgres 16 after the change, any such row
takes 40-80 ms, and a 500-row batch of ordinary 1 KB requests got faster (~0.9 ms/row, was ~1.4).

The bracket passes for a configured field that holds an object or array (`"cookies":{...}`) are **guarded**: they
run only when a listed field is actually followed by `{` or `[`. Unguarded they tripled the regex count per dump and
measured 0.25 ms -> 10.7 ms per dump (about 20 ms per row with both columns, so a 1000-row pump batch would stall
~20 s); guarded it is 0.30 ms. A database spec (`pump-redaction.db-spec.ts`, the last case) inserts 1200 ordinary
rows and fails if that batch takes more than 8 s (about 1 s measured; about 24 s without the guard).

A dump that cannot be decoded (a gzip/binary body is not UTF-8) is stored as the base64
of `[UNREDACTABLE: non-UTF8 body]` in that column only: never the unredacted original, and never an
error that would abort the pump's whole batch.

If the trigger was missing or disabled when it is (re)installed — e.g. the pump created the table
after the API booted — the same statement redacts the dumps already stored, in the same transaction, so "trigger
present" always means "stored rows redacted". Until then the traffic inspector reports the capture
as failed rather than showing anything.

Because a trigger cannot read `process.env` per row, the field list is baked into the trigger
function body at API-boot time; a changed `ANALYTICS_REDACT_FIELDS` takes effect on the next boot,
not live.

`GET /analytics/export` deliberately does **not** include `rawrequest`/`rawresponse` in its CSV — see
the Endpoints table above.

## Retention

A daily cron (03:00, `analytics-retention.scheduler.ts`) trims both tables, each statement guarded by
`to_regclass`. When `tyk_analytics` exists it first re-applies the index DDL and the redaction
trigger (the second chance for a table created after boot, see above):

| Env var | Default | Table |
|---|---|---|
| `ANALYTICS_RETENTION_DAYS` | 30 | `tyk_analytics` — `"timestamp" < now() - make_interval(days => $1::int)` |
| `ANALYTICS_AGGREGATE_RETENTION_DAYS` | 365 | `tyk_aggregated` — `"timestamp" < EXTRACT(EPOCH FROM now() - make_interval(days => $1::int))::bigint` |

The aggregate cutoff compares the **bare bigint column** against a computed epoch; wrapping the
column in `to_timestamp()` would make `tyk_aggregated_idx_dimension` unusable.

`ScheduleModule.forRoot()` is registered once, in `QuotasModule`. `AnalyticsModule` only declares the
cron provider — a second root is an error.

### Storage cost (measured, WP21)

Now that detailed recording is on (`omit_detailed_recording: false`), `tyk_analytics` rows are
meaningfully bigger — the two base64 dump columns dominate. Measured against a real
gateway+pump+Postgres, 101 rows of a representative traffic mix (a ~400-byte GET/POST request with
one auth header, a small JSON body, a ~1000-byte response), **with the redaction trigger and all
three of this table's own indexes (`og_tyk_analytics_*`) already applied**:

| Metric | Measured |
|---|---|
| Row payload alone (`pg_column_size`) | ~1.85 KB/row → **~1.85 GB per million requests** |
| Table + these 3 indexes (`pg_total_relation_size`) | ~2.8 KB/row → **~2.8 GB per million requests** |

Actual cost scales with real request/response size (a large body costs more; an API with detailed
recording left off for that API costs ~0, its `rawrequest`/`rawresponse` stay empty). At the default
`ANALYTICS_RETENTION_DAYS=30`, a tenant sustaining 1M detailed-recording requests/day should budget
**~85 GB** for `tyk_analytics` alone at steady state (30 × ~2.8 GB) before it starts aging out. Turn
detailed recording off per-API (WP15b's `enable_detailed_recording` toggle) for APIs that don't need
request/response bodies in analytics — the scalar columns alone (no detailed recording) cost a few
hundred bytes/row, not ~2.8 KB.

## Traffic search projection

`POST /analytics/traffic/search` does not read `tyk_analytics`. It reads `og_traffic_search`, a separate table
the API fills from the captured rows, so searching can have its own indexes without slowing the pump's inserts.
The search table is created and maintained by the API; the pump never sees it.

```
tyk_analytics (pump, trigger-redacted)
      │  every 10 s (+ hourly over 6 h): re-read a lookback window
      ▼
TrafficSearchIndexerService ── parseHttpDump(dump, apiAuthHeader) ──► og_traffic_search (daily partitions)
                                                                              ▲
POST /analytics/traffic/search ── typed clauses, tenant's Tyk API ids, window ┘
```

**Why a copy and not indexes on `tyk_analytics`.** The dumps there are base64 text, so they cannot be searched
without decoding every row, and a full-text index on a table the pump writes would put its cost on the pump's
insert path (measured below: the full-text index cuts inserts from thousands of rows per second to hundreds).
The projection holds decoded, redacted text in its own table, written by one indexer in batches of 500.

**Table** (`search/traffic-search.ddl.ts`, created at API boot and every 6 hours, idempotent, not a Prisma
migration because a table absent from `schema.prisma` is proposed for DROP): `og_traffic_search`, range-partitioned
by UTC day on `ts`, columns `id` (from a sequence: a partitioned table cannot have an identity column on PG 16),
`ts`, `apiid`, `method`, `path`, `status`, `latency_ms`, `key_alias`, `ip`, `req_headers` / `res_headers` (`jsonb`,
lower-case names), `req_body` / `res_body` (text, at most 16 KiB each), `req_truncated` / `res_truncated`,
`dedupe_key`. `og_traffic_search_state` holds one row, `scanned_until`.

| Index | Serves |
|---|---|
| unique `(ts, dedupe_key)` | `ON CONFLICT DO NOTHING`: a repeated scan inserts nothing |
| `(apiid, ts DESC)`, `(apiid, method, ts DESC)` | tenant + window, newest first; method filter |
| GIN `jsonb_path_ops` on each header column | `header:` clauses (`@>` for a value, `@?` for "exists") |
| GIN on `to_tsvector('simple', coalesce(req_body,'') \|\| ' ' \|\| coalesce(res_body,''))` | word/phrase search on either body; a `req:`/`res:` search adds an exact recheck on that side |

Left out on purpose (measured expensive or unused, see below): trigram indexes on bodies and path, a JSON-body
index, a partial `status >= 500` index, a path index. The full-text index is on an **expression**, not a stored
`tsvector` column (a stored column adds about 3 KB per row of TOAST); `search/traffic-search.sql.ts` holds the
expression once and both the DDL and the query builder import it, because Postgres uses an expression index only
when the query repeats the exact expression (a test asserts the compiled query contains it).

**Retention.** One partition per day; the store keeps today and the next two days ready and drops a partition
when its whole day is older than `ANALYTICS_RETENTION_DAYS` (default 30, the same knob as the raw table). Dropping
a partition is a metadata operation: no row deletes, no bloat.

**Indexer.** `TrafficSearchIndexerService`:
- `tyk_analytics` has no id column, and the pump writes batches that can arrive out of order, so there is no cursor
  to resume from. Each tick re-reads from `scanned_until` minus 15 minutes; an hourly pass reaches back 6 hours.
  Inserting `ON CONFLICT (ts, dedupe_key) DO NOTHING` makes re-reading free and a late row still lands.
  `dedupe_key = sha256(apiid | timestamp (µs) | apikey | method | path | responsecode | latency_total | requesttime)`.
  **Ceiling:** a record the pump delivers later than 6 hours is never indexed; two requests identical in all of
  those columns and in the microsecond collapse into one row.
- Reads are a keyset over `(timestamp, dedupe_key)` in pages of 500, so a thousand rows with the same timestamp are
  neither skipped nor repeated. Timestamps travel as text with microseconds (a JS `Date` would round them).
- The first scan reaches back `TRAFFIC_SEARCH_BACKFILL_DAYS` (default 7, never more than retention). Rows older than
  the retention window are not indexed.
- It **refuses to index while the redaction trigger is missing or disabled** (the same check the inspector makes).
- One scan at a time; a failed tick is logged and retried from the same point. It never throws into the scheduler.

**Redaction at index time.** Every dump goes through `parseHttpDump`, the pass the traffic inspector displays with,
with each API's own `authHeaderName`, so what is searchable is exactly what a person could already see: a value
shown as `[REDACTED]` cannot be found by searching for it (a search would otherwise be an oracle for secrets). A
multipart body is stored as a fixed placeholder, because the parser does not understand boundaries. A header that
matches no secret pattern and is not the API's configured auth header is **not** redacted (a test shows the
difference). A spec plants eight secrets (bearer token, cookie, password, a nested `cookies` object, a custom auth
header, query-string and response tokens, a multipart secret) and asserts none is in any column and none is found
by any body or header clause. Known gaps, inherited from the inspector: a stray `"` in a non-JSON body, a token in a
URL path segment, a JWT in a field whose name is not secret-looking.

**Freshness.** `indexedUntil` in every response is `scanned_until`; the UI shows it. An empty result before that
instant is real; after it, the row may not be indexed yet. A request is searchable about 10 seconds after the pump
has written it, plus the pump's own purge delay (`purge_delay: 10`).

**Limits the API enforces** (`SEARCH_LIMITS`): at most 8 clauses and 3 body clauses; body and path terms of at least
3 letters or digits; the words `id, data, name, value, true, false, null, type, status, message` are refused as body
terms (measured: `id` alone ran to the 3 s timeout over 30 days); values up to 200 characters; pages of up to 100
with a keyset cursor and no total (`count(*)` over 30 days measured 192 ms); a window is always applied; a 3 s
statement budget per request (`TRAFFIC_SEARCH_TIMEOUT_MS`).

**What search cannot do.** Substring, regular-expression, JSON-field and path-glob search were measured and left
out. Word search does not stem (`fund` does not find `funds`). It covers only the first 16 KiB of each body (the
trigger cuts a dump at 16,384 characters before anything else); about 15% of responses in the test data hit the
cap. A common word over a long window is refused or times out rather than answered slowly.

| Variable | Default | Meaning |
|---|---|---|
| `ANALYTICS_RETENTION_DAYS` | 30 | Also the partition retention of the search table |
| `TRAFFIC_SEARCH_BACKFILL_DAYS` | 7 | How far the first indexer scan reaches back (capped at retention) |
| `TRAFFIC_SEARCH_TIMEOUT_MS` | 3000 | Per-search statement budget, clamped to 100-10000 |

**Measured cost (PostgreSQL 16.13, one 500,000-row load of realistic captured dumps, in batches of 500, with every
index in place).** Figures come from a throwaway container on a developer laptop, not from production; treat them
as orders of magnitude.

| | 102,000 rows | 500,000 rows |
|---|---|---|
| Total size | 586 MB (6.0 KB/row) | 2,815 MB (5.9 KB/row) |
| Table (heap + TOAST) | 235 MB | 1,157 MB (2.4 KB/row) |
| All indexes | 350 MB | 1,658 MB (3.5 KB/row) |
| Full-text index alone | 304 MB | 1,453 MB (3.0 KB/row), about 88% of index size |
| Both header indexes | 28 MB | 114 MB |

- **Write rate.** Between 234 rows/s (first 25,000) and about 180-195 rows/s (last 25,000), sustained over the
  whole load. Compare this with your own traffic: the indexer must sustain your peak captured-request rate.
- **Query time, median over repeated runs** (500,000 rows; "24h" is about 71,000 rows, "7d" covers all of them):

| Filter | 24h | 7d |
|---|---|---|
| status >= 500 | 11 ms | 10 ms |
| header equals / exists | 3.4 / 1.8 ms | 9.8 / 2.1 ms |
| latency > 800 and POST | 15 ms | 17 ms |
| path prefix | 3.3 ms | 3.2 ms |
| unfiltered newest page | 1.3 ms | 1.6 ms |
| word in either body | 35 ms | 136 ms |
| status + method + word + header | 23 ms | 117 ms |
| `COUNT(*)` of a filter (not used by search) | 81 ms | 364 ms |

  The full-text index is what grows with the window: a word search over a week is about four times slower than
  over a day. That is why the endpoint has a statement budget and answers `SEARCH_TOO_BROAD` instead of running
  long.
- **Retention.** Dropping one day partition (71,428 rows, all indexes) took 23 ms to detach and 476 ms to drop,
  so expiry never blocks the table.
- **Caveat.** The 500,000 rows were staged in time order, so this run says nothing about concurrent writes
  during a query.


## Debugging an empty pipeline

```bash
# 1. Is the pump alive and did both pumps initialise?
docker compose -f infra/docker-compose.yml logs tyk-pump | grep -E "Init Pump|error|Purged"

# 2. Did the gateway emit anything? (records buffer under this Redis key)
docker compose -f infra/docker-compose.yml exec -T redis redis-cli keys 'analytics-*'

# 3. Do the tables exist and hold rows for the expected apiid?
docker compose -f infra/docker-compose.yml exec -T postgres psql -U opengateway -d opengateway \
  -c '\dt tyk_*' -c "\di og_tyk_analytics*" \
  -c 'SELECT apiid, count(*), max("timestamp") FROM tyk_analytics GROUP BY apiid;' \
  -c "SELECT dimension, dimension_value, counter_hits, counter_success, counter_error
        FROM tyk_aggregated WHERE dimension IN ('apiid','apikeys');"

# 4. What does the API think?
curl -s -b /tmp/og.jar https://localhost:33001/api/analytics/health
```

| Symptom | Cause |
|---|---|
| Dashboard says "Tyk Pump is not running" | `pumpReachable:false`: the pump is stopped, `PUMP_HEALTH_URL` is unset on the API, or the pump's `health_check_endpoint_*` changed (`docker compose exec api node -e "fetch(process.env.PUMP_HEALTH_URL).then(r=>console.log(r.status))"`) |
| Pump exits seconds after start | `dont_purge_uptime_data` missing → uptime pump kills the process |
| Tables never appear | Pump cannot reach Postgres, or it has purged nothing yet (tables are created on first purge) |
| Rows in `tyk_analytics`, none in `tyk_aggregated` | Only the `sql` pump initialised — check for `Init Pump: POSTGRESAGGREGATE` |
| Tables full, API reports zeros | The tenant's APIs have no `tykApiId` (never synced), or the traffic hit a different `apiid` |
| `counter_hits` > 0 but 2xx shows 0 | Reading `code_2x`/`code_200` instead of `counter_success` (Trap 1) |
| Latency looks too high/low | Averaging `counter_latency` across rows instead of re-weighting (Trap 2) |
| No rows for one API only | `config.doNotTrack = true` → `do_not_track` on the Tyk definition. If nobody set that and it's still off: the API predates the 2026-09-27 mapper fix (an unset `doNotTrack` used to default OAS-format APIs to untracked, the opposite of classic's default) — re-sync it (`POST /apis/:id/sync`) to pick up the corrected default |
| Unauthenticated traffic missing from key charts | Expected — `apikey = '00000000'` is excluded |
