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
