# Configuration reference (environment variables)

Sources read: `apps/api/.env.example`, `apps/web/.env.example`, `install.sh` (what it writes to `infra/.env`, `apps/api/.env.local`, `apps/web/.env.local`), the `environment:`/`args:` blocks of `infra/docker-compose.yml` and `infra/docker-compose.prod.yml`, `apps/web/Dockerfile`, and code that reads `process.env` / `ConfigService.get` in `apps/api/src`, `apps/web/src`, `packages/database`. `infra/.env` and `apps/web/.env.local` were deliberately not opened; no secret values appear here.

There is no zod/Joi env schema in the API (grep of `apps/api/src/app.module.ts` found none): the API reads variables lazily through Nest `ConfigService` with per-call defaults. Web uses plain `process.env` reads with in-code fallbacks. Anything marked "unverified" could not be confirmed from a file.

Legend: **Req** = required for the stack/component to start (Y, N, or "Y (compose)" when only compose interpolation `${VAR:?}` enforces it). **Secret** = value must not be logged or committed.

Where variables live in a compose install:

- `infra/.env` (git-ignored, mode 600, written by `install.sh`, read by docker compose for `${...}` interpolation). Holds secrets plus any operator overrides.
- `apps/api/.env.local`, `apps/web/.env.local`: host-side (`pnpm dev`) files also written by `install.sh`. The containers do not read them (they get values from compose `environment:`).
- Values in compose `environment:` win for containers.

## 1. API (`apps/api`, container `api`)

| Variable | Default (code) | Compose value | Req | Secret | Purpose / read by |
|---|---|---|---|---|---|
| `PORT` | `33001` (`apps/api/src/main.ts`) | `4000` | N | N | Listen port. `.env.example` sets 33001 for host-side dev |
| `NODE_ENV` | `development` (`main.ts`); `app.module.ts` reads `process.env.NODE_ENV` directly | base `development`; prod overlay `production` | N | N | `production` => throttler 100 req/min per IP, otherwise 1000/min (`ThrottlerModule.forRoot`, `app.module.ts`) |
| `DATABASE_URL` | none | `postgresql://opengateway:${DB_PASS}@postgres:5432/opengateway?schema=public` | Y | Y (embeds password) | Prisma datasource (`packages/database/prisma/schema.prisma`: `env("DATABASE_URL")`) |
| `REDIS_URL` | `redis://localhost:33003` (`common/redis/redis.service.ts`) | `redis://redis:6379`; prod `redis://:${REDIS_PASSWORD}@redis:6379` | N | Y when it has a password | Redis client |
| `JWT_SECRET` | none | `${JWT_SECRET:?}` | Y (compose only) | Y | **Not used to sign or verify anything** since the Ory cutover. `apps/api/.env.example` says "Unused"; the only code touching it is `modules/auth/jwt-secret.ts`, which `token.service.ts` marks as safe to delete. Compose still refuses to start without it. Whether `jwt-secret.ts` is invoked at boot is unverified |
| `JWT_EXPIRES_IN` | none | `15m` | N | N | Leftover; `token.service.ts` references it, but real TTLs are Hydra's (`ttl.access_token` 1h) |
| `JWT_REFRESH_EXPIRES_IN` | none | `7d` | N | N | Leftover (`token.service.ts`), real refresh TTL is Hydra's 720h |
| `ORY_HYDRA_PUBLIC_URL` | none | `http://hydra:4444` | Y | N | JWKS fetch in `modules/auth/strategies/jwt.strategy.ts` (in-network host) |
| `ORY_HYDRA_ADMIN_URL` | none | `http://hydra:4445` | Y | N | Hydra admin client (`oauth-clients/services/hydra-admin.service.ts`, `api-management/services/api.service.ts`) |
| `ORY_HYDRA_ISSUER` | none | `https://localhost:33010/` | Y | N | Expected `iss` claim (`jwt.strategy.ts`, `oauth-client.service.ts`). Must be the browser-facing URL and match `urls.self.issuer` in `infra/ory/hydra/hydra.yml`, trailing slash included |
| `ORY_KRATOS_PUBLIC_URL` | none | `http://kratos:4433` | Y | N | `common/ory/kratos.ts` |
| `ORY_KRATOS_ADMIN_URL` | none | `http://kratos:4434` | Y | N | `common/ory/kratos.ts`, `portal/services/developer.service.ts` |
| `ORY_KETO_READ_URL` | none | `http://keto:4466` | Y | N | Keto check API (`common/ory/keto.ts`) |
| `ORY_KETO_WRITE_URL` | none | `http://keto:4467` | Y | N | Keto tuple writes (`common/ory/keto.ts`, `packages/database/prisma/seed.ts`) |
| `CORS_ORIGINS` | `http://localhost:33000` (`main.ts`) | `https://localhost:33000` | N | N | Comma-separated allowed origins; credentials enabled |
| `COOKIE_SECURE` | see note | `${COOKIE_SECURE:-true}` | N | N | Documented in `apps/api/.env.example` and parsed by `parseCookieSecure` in `common/config/env.ts`, but **no call site was found in `apps/api/src`** (only the definition and its spec). The session cookies are set by `apps/web`, which reads its own `COOKIE_SECURE` (section 2). Treat the API-side variable as inert unless a call site is found (unverified beyond the grep) |
| `TRUST_PROXY_HOPS` | `0` (invalid or empty => 0, warns) | `${TRUST_PROXY_HOPS:-1}` | N | N | Express `trust proxy` hop count (`main.ts`, `parseTrustProxyHops`). Must be an integer, never `true`. `1` is correct behind the edge (Caddy replaces `X-Forwarded-For`) |
| `TYK_ADMIN_URL` | `''` | `http://tyk-gateway:8081/tyk` | Y | N | Tyk control API base including `/tyk` (`tyk-integration/services/tyk-client.service.ts`) |
| `TYK_ADMIN_URLS` | `''` (falls back to `TYK_ADMIN_URL`) | `${TYK_ADMIN_URLS:-}`; prod overlay defaults to nodes 1-3 `:8081/tyk` | N | N | Comma-separated control APIs of every gateway node, each with `/tyk`. Writes fan out and drift is detected per node. Node list is config, not discovered |
| `TYK_ADMIN_SECRET` | `''` | `${TYK_GW_SECRET:-tyk-gateway-secret}` | Y | Y | Sent as `x-tyk-authorization`. Must equal the gateway's `TYK_GW_SECRET` |
| `TYK_GATEWAY_URL` | `''` | `http://tyk-gateway:8081` | Y | N | Base for the `GET /hello` health probe (served on the control port) |
| `TYK_WEBHOOK_RELAY_SECRET` | none | `${...:?}` | Y (compose) | Y | Shared secret Tyk's event handler presents on `POST /api/webhooks/relay/:apiId`; empty makes the relay reject everything (`webhooks/controllers/webhook-relay.controller.ts`, `webhook-relay.constants.ts`) |
| `TYK_ORG_ID` | none | not set | N | N | **Removed in WP12c and read by nothing** (`tenant-scope.ts` only mentions it in a comment). The org id is per tenant (`Tenant.tykOrgId`). `install.sh` still writes `TYK_ORG_ID=org123` into `apps/api/.env.local`, harmless |
| `PROXY_DENY_HOSTS` | unset | `""` | N | N | Extra hosts an API may not proxy to (`api-management/dto/proxy-url.validator.ts`), on top of the built-in denylist |
| `SPEC_FETCH_ALLOWED_HOSTS` | unset (public hosts only) | `${SPEC_FETCH_ALLOWED_HOSTS:-}` | N | N | Private hosts/CIDRs (`host[:port]` or `CIDR[:port]`) OpenAPI documents may be fetched from. Invalid entry fails at startup (`spec-fetch/spec-fetcher.service.ts`, `docs/OAS-SPEC-FETCH.md`) |
| `PUMP_HEALTH_URL` | `''` (reported as pump not running) | `http://tyk-pump:8083/health` | N | N | Pump liveness probe (`analytics/services/pump-health.service.ts`) |
| `ANALYTICS_RETENTION_DAYS` | `30` | not set | N | N | Raw analytics retention (daily cron; `analytics-retention.scheduler.ts`, `settings.service.ts`) |
| `ANALYTICS_AGGREGATE_RETENTION_DAYS` | `365` | not set | N | N | Aggregate retention |
| `ANALYTICS_REDACT_FIELDS` | built-in list `DEFAULT_REDACT_FIELDS` (`password`, `pass`, `secret`, `token`, `authorization`, ...) | not set | N | N | Comma-separated field names redacted from stored request dumps. Baked into a DB trigger at API boot: a change applies on the next boot. Not in `.env.example` |
| `FEATURE_INVITE_BY_EMAIL` | off unless exactly `true` | not set | N | N | Enables invite-by-email route (`tenants/controllers/tenant.controller.ts`). Read once at startup from `process.env` only (a value in `.env.local` is loaded too late). Must match web's `NEXT_PUBLIC_FEATURE_INVITE_BY_EMAIL` |
| `EDGE_ROOT_CERT_PATH` | `/etc/open-gateway/edge-root.crt` (`observability/metrics.service.ts`) | `/etc/open-gateway/edge/root.crt` | N | N | Edge root CA read on every `/api/metrics` scrape for the expiry gauge. Absent file => gauge absent |
| `EDGE_TLS_PROBE` | `edge:33001` (`metrics.service.ts`) | `${EDGE_TLS_PROBE:-edge:33001}` | N | N | host:port TLS handshake target used to read leaf/intermediate expiry |
| `LOG_LEVEL` | unknown | not set | N | N | In `apps/api/.env.example` (`debug`) and written by `install.sh`. **No reader found** in `apps/api/src` by grep (pino level may be configured elsewhere; unverified) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset => tracing off (`apps/api/src/tracing.ts`) | `http://otel-collector:4318` | N | N | Enables the OpenTelemetry SDK (HTTP/protobuf). The exporter also honours standard `OTEL_*` variables |
| `OTEL_SERVICE_NAME` | SDK default | `open-gateway-api` | N | N | Service name for traces |
| `KRATOS_ADMIN_URL` | none | passed by `install.sh` via `docker compose run -e` (`http://kratos:4434`) | N | N | Only `packages/database/scripts/migrate-users-to-kratos.ts` |

Test/acceptance-only variables (not needed to run the stack): `OG_THROWAWAY_DATABASE_URL` and `DATABASE_URL` in `*.db-spec.ts`; `TYK_ADMIN`, `TYK_DATA`, `TYK_DATA_URL`, `TYK_EDGE`, `TYK_EDGE_URL`, `TYK_NODES`, `TYK_TEST_UPSTREAM`, `SLOW_UPSTREAM`, `ECHO*`, `REDIS_HOST`, `TYK_ADMIN_URL`, `TYK_ADMIN_SECRET` in `packages/database/scripts/wp*-acceptance.ts` and `wp12c-tenant-org-cutover.ts`.

Session cookie names (defined in `apps/web/src/lib/cookie-names.ts`, read by the API in `jwt.strategy.ts`): `mq_access_token`, `mq_refresh_token`. Both are httpOnly, `SameSite=Lax`, path `/` (`apps/web/src/lib/oauth-cookies.ts`). The short-lived flow cookie is `oauth2_flow`. The `mq_` prefix was added in commit `1bac7c0` so they stop colliding with other local apps; `apps/api/.env.example` still calls them `access_token/refresh_token`.

## 2. Web (`apps/web`, container `web`)

`NEXT_PUBLIC_*` values are inlined into the client bundle at **build time** (`apps/web/Dockerfile` `ARG` -> `ENV`; compose `web.build.args`). Changing one requires a rebuild. Non-prefixed variables are read at runtime on the server.

| Variable | Default (Dockerfile / code) | Compose (build arg / runtime) | Req | Secret | Purpose / read by |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | Dockerfile `https://localhost:33001/api` | both: `https://localhost:33001/api` | Y | N | API base for the browser (`lib/api-client.ts`, `lib/portal-api-client.ts`). Note `apps/web/.env.example` shows it WITHOUT `/api` (`https://localhost:33001`) while compose/Dockerfile/`install.sh` include `/api` |
| `NEXT_PUBLIC_APP_URL` | Dockerfile `https://localhost:33000` | build arg `https://localhost:33000` | N | N | The app's public origin, client side; also fallback for `APP_URL` (`lib/hydra-admin.ts`) |
| `APP_URL` | falls back to `NEXT_PUBLIC_APP_URL` | runtime `https://localhost:33000` | N (but load-bearing) | N | Server-side public origin for the open-redirect check (`sanitizeReturnTo`, `lib/return-to.ts`, `lib/hydra-admin.ts`). A deployment on another origin that forgets it silently flattens every `return_to` to `/` |
| `NEXT_PUBLIC_KRATOS_URL` | Dockerfile `https://localhost:33012` | both | Y | N | Browser-facing Kratos (`lib/kratos-client.ts`) |
| `NEXT_PUBLIC_HYDRA_URL` | Dockerfile `https://localhost:33010` | both | Y | N | Browser-facing Hydra; `/oauth2/authorize` redirects the browser here (`lib/hydra-admin.ts`) |
| `NEXT_PUBLIC_GATEWAY_URL` | Dockerfile `https://localhost:33005` | both | N | N | Gateway data plane for the portal try-it console (`lib/gateway-url.ts`) |
| `NEXT_PUBLIC_GATEWAY_NODE_LOCATIONS` | empty (map shows no pins) | build arg `${NEXT_PUBLIC_GATEWAY_NODE_LOCATIONS:-}` from `infra/.env` | N | N | See below |
| `NEXT_PUBLIC_FEATURE_INVITE_BY_EMAIL` | off unless exactly `true` | not set in compose | N | N | Shows invite offer (`components/tenants/invite-member-sheet.tsx`). Build time; must match API `FEATURE_INVITE_BY_EMAIL` |
| `NEXT_PUBLIC_ENABLE_ANALYTICS`, `NEXT_PUBLIC_ENABLE_WEBSOCKETS` | n/a | not set | N | N | Listed in `apps/web/.env.example` (`false`) but **no reader found** in `apps/web` by grep (unverified whether other packages read them) |
| `HYDRA_PUBLIC_URL` | `http://hydra:4444` (`lib/hydra-admin.ts`) | `http://hydra:4444` | N | N | Server-to-server token exchange |
| `HYDRA_ADMIN_URL` | `http://hydra:4445` | `http://hydra:4445` | N | N | Login/consent challenge handling. Host-side dev: `http://127.0.0.1:33011` |
| `KRATOS_INTERNAL_URL` | `http://kratos:4433` (`lib/kratos-server.ts`) | `http://kratos:4433` | N | N | Server-side Kratos calls |
| `DATABASE_URL` | none | `postgresql://opengateway:${DB_PASS}@postgres:5432/opengateway?schema=public` | Y | Y | Web writes to Postgres in one place: `/oauth2/login` provisions the local `User` row. Without it login returns 500 |
| `COOKIE_SECURE` | unset => `NODE_ENV === 'production'` (`lib/oauth-cookies.ts`) | **not set on `web`** (compose sets it only on `api`) | N | N | `true`/`false` (case-insensitive) forces the `Secure` flag on `mq_access_token`, `mq_refresh_token`, `oauth2_flow`. Base compose runs web with `NODE_ENV=development`, so these cookies are not `Secure` on the default stack despite HTTPS; the prod overlay sets `NODE_ENV=production` |
| `NODE_ENV` | image sets `production` (`Dockerfile`) | base compose overrides to `development`; prod overlay `production` | N | N | Also affects `next.config.ts` logging and `kratos-flow-form.tsx` |
| `PORT`, `HOSTNAME` | `3000`, `0.0.0.0` (`Dockerfile`) | not set | N | N | Next standalone server |
| `NEXT_TELEMETRY_DISABLED` | `1` (`Dockerfile`) | not set | N | N | |

### `NEXT_PUBLIC_GATEWAY_NODE_LOCATIONS`

Parsed by `parseLocations` in `apps/web/src/lib/gateway-locations.ts`, evaluated once at module load.

- Value is a JSON object: key = the gateway node URL **host** (with port, e.g. `gw-ma-01:8080`), value = either
  - a **city id** from the catalogue `apps/web/src/lib/gateway-cities.ts`, format `<country code>-<CITY>`, e.g. `MA-CASABLANCA`, `MA-ELJADIDA`, `FR-PARIS`; or
  - an explicit object `{"city": string (required), "code": string (optional label), "lat": -90..90, "lon": -180..180}`.
- Example (from `.env.example`): `{"gw-ma-01:8080":"MA-CASABLANCA","gw-eu-01:8080":"FR-PARIS","gw-x:8080":{"city":"Lab","lat":10,"lon":20}}`.
- Invalid JSON, unknown city ids and invalid explicit objects are silently dropped (the node is then listed but not pinned). The map only draws lon -92..31 and lat 14..64 (`isOnMap`); nodes outside are listed, not pinned.
- Baked at build time, so it must be a **build arg**: the base compose passes `${NEXT_PUBLIC_GATEWAY_NODE_LOCATIONS:-}` from `infra/.env` (single-quote the JSON there), and `apps/web/Dockerfile` declares `ARG NEXT_PUBLIC_GATEWAY_NODE_LOCATIONS=`. It is not in `web.environment`. Rebuild `web` after changing it. Key hosts must match the hosts of the URLs in `TYK_ADMIN_URLS` / `TYK_ADMIN_URL` (how nodes are keyed: inferred from the `.env.example` comment, unverified in the API code).

## 3. Gateway (Tyk `tyk-gateway`, nodes 2 and 3)

Set in the `x-tyk-gateway-env` anchor in `infra/docker-compose.yml`. Every node gets identical values. All are compose-level; only `TYK_GW_SECRET` and (prod) `REDIS_PASSWORD` come from `infra/.env`.

| Variable | Value | Secret | Purpose |
|---|---|---|---|
| `TYK_GW_SECRET` | `${TYK_GW_SECRET:-tyk-gateway-secret}` | Y | Control API secret. Default is dev-only and rejected by `prod-preflight`. Same value feeds api `TYK_ADMIN_SECRET` |
| `TYK_GW_LISTENPORT` | `8080` | N | Data plane |
| `TYK_GW_CONTROLAPIPORT` | `8081` | N | Control API and `/hello` move here; not published |
| `TYK_GW_USEDBAPPCONFIGS` | `false` | N | Definitions are files in `/opt/tyk-gateway/apps` |
| `TYK_GW_STORAGE_TYPE`, `_HOST`, `_PORT` | `redis`, `redis`, `6379` | N | Redis backend |
| `TYK_GW_STORAGE_PASSWORD` | prod overlay: `${REDIS_PASSWORD:?}` | Y | Redis auth (prod only) |
| `TYK_GW_ALLOWINSECURECONFIGS` | `true` | N | |
| `TYK_GW_HTTPSERVEROPTIONS_ENABLEWEBSOCKETS` | `true` | N | WebSocket/SSE passthrough |
| `TYK_GW_DISABLEPORTWHITELIST` | `true` | N | Lets `protocol:"tcp"` APIs open their `listen_port` (33020 maps to 6000) |
| `TYK_GW_ENABLEANALYTICS`, `TYK_GW_ANALYTICSCONFIG_TYPE`, `_ENABLEDETAILEDRECORDING`, `_STORAGEEXPIRATIONTIME` | `true`, `""`, `false`, `3600` | N | Buffer analytics in Redis for the pump |
| `TYK_GW_HASHKEYS` | `true` | N | |
| `TYK_GW_ENFORCEORGQUOTAS`, `TYK_GW_ENFORCEORGDATAAGE` | `true` | N | Both required for the per-tenant org cutoff |
| `TYK_GW_POLICIES_POLICYSOURCE`, `_POLICYPATH`, `_ALLOWEXPLICITPOLICYID` | `file`, `/opt/tyk-gateway/policies`, `true` | N | File-backed policies; OAuth client id = policy id |
| `TYK_GW_OPENTELEMETRY_ENABLED`, `_EXPORTER`, `_ENDPOINT`, `_SPANPROCESSORTYPE`, `_SAMPLING_TYPE`, `_RESOURCENAME` | `true`, `grpc`, `otel-collector:4317`, `simple`, `AlwaysOn`, `open-gateway-tyk` | N | Tracing |

Note that `infra/gateway/tyk.conf` is an empty directory; the gateway has no config file (see `docs/reference/infrastructure.md`).

## 4. Pump (`tyk-pump`)

Base configuration in `infra/pump/pump.conf`; env overrides in compose.

| Variable | Value | Secret | Purpose |
|---|---|---|---|
| `TYK_PMP_PUMPS_POSTGRES_META_CONNECTIONSTRING` | `host=postgres port=5432 user=opengateway password=${DB_PASS:?} dbname=opengateway sslmode=disable` | Y | Overrides the empty-password `connection_string` in `pump.conf` (raw pump) |
| `TYK_PMP_PUMPS_POSTGRESAGGREGATE_META_CONNECTIONSTRING` | same | Y | Aggregate pump |
| `TYK_PMP_ANALYTICSSTORAGECONFIG_PASSWORD` | prod only: `${REDIS_PASSWORD:?}` | Y | Redis auth (`analytics_storage_config.password`). Rule: `TYK_PMP_` + config path uppercased, underscores inside a segment removed |

## 5. Ory (Hydra, Kratos, Keto)

| Variable | Component | Compose source | Req | Secret | Purpose |
|---|---|---|---|---|---|
| `DSN` | hydra, hydra-migrate | `postgres://opengateway:${DB_PASS}@postgres:5432/hydra?sslmode=disable` | Y | Y | DB `hydra` |
| `DSN` | kratos, kratos-migrate | `.../kratos?...` | Y | Y | DB `kratos` |
| `DSN` | keto, keto-migrate | `.../keto?...` | Y | Y | DB `keto` |
| `SECRETS_SYSTEM` | hydra | `${HYDRA_SECRETS_SYSTEM:?}` | Y | Y | Hydra system secret (`install.sh` generates `openssl rand -hex 32`) |
| `SECRETS_COOKIE` | hydra | `${HYDRA_SECRETS_COOKIE:?}` | Y | Y | Hydra cookie secret |
| `SECRETS_DEFAULT` | kratos | `${KRATOS_SECRETS_DEFAULT:?}` | Y | Y | |
| `SECRETS_COOKIE` | kratos | `${KRATOS_SECRETS_COOKIE:?}` | Y | Y | |
| `SECRETS_CIPHER` | kratos | `${KRATOS_SECRETS_CIPHER:?}` | Y | Y | **Exactly 32 characters** (`install.sh` uses `rand_hex 16`) |
| `COURIER_SMTP_CONNECTION_URI` | kratos | `${KRATOS_SMTP_URI:-smtp://mailpit:1025/?skip_ssl_verify=true&disable_starttls=true}` | N | Y if it carries credentials | Set `KRATOS_SMTP_URI` in `infra/.env` to send real mail; default delivers to Mailpit (UI on `127.0.0.1:33016`) |
| `SESSION_COOKIE_SECURE` | kratos | `${KRATOS_COOKIE_SECURE:-false}` | N | N | Kratos session cookie `Secure` flag. Default `false` in the base file even though Kratos is served over HTTPS |

Non-env Ory settings (issuer, UI URLs, CORS, TTLs) are hard-coded to `https://localhost:330xx` in `infra/ory/hydra/hydra.yml`, `infra/ory/kratos/kratos.yml`; change those files for another origin. `infra/ory/keto/keto.yml` and `namespaces.ts` hold Keto's ports and namespaces.

## 6. Postgres

| Variable | Value | Secret | Purpose |
|---|---|---|---|
| `POSTGRES_USER` | `opengateway` (literal) | N | |
| `POSTGRES_PASSWORD` | `${DB_PASS:?}` | Y | Shared by app DB and the three Ory DBs |
| `POSTGRES_DB` | `opengateway` (literal) | N | |
| `DB_PASS` (in `infra/.env`) | generated by `install.sh` | Y | Interpolated into every DSN, `PGPASSWORD` of the ancillary jobs, and the pump connection strings. Required |
| `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | `postgres`, `opengateway`, `${DB_PASS}`, `opengateway` | Y (password) | `pg-archive-init` uses none; `postgres-backup`, `ory-db-init`, `pg-monitoring-init` |
| `PG_BACKUP_INTERVAL` | `${PG_BACKUP_INTERVAL:-86400}` | N | Seconds between base backups (`postgres-backup`, also its healthcheck) |
| `PG_BACKUP_KEEP` | `${PG_BACKUP_KEEP:-7}` | N | Base backups kept |
| `PG_EXPORTER_PASSWORD` | `${...:-}` in base; `${...:?}` in prod overlay | Y | Password of the `og_monitor` role; must be >= 32 characters or `pg-monitoring-init` exits 1 |

## 7. Redis

| Variable | Value | Secret | Purpose |
|---|---|---|---|
| `REDIS_PASSWORD` | prod overlay only: `${REDIS_PASSWORD:?}`; base ignores it | Y | `--requirepass`, and injected as `REDISCLI_AUTH` (redis), `TYK_GW_STORAGE_PASSWORD` (gateways), `TYK_PMP_ANALYTICSSTORAGECONFIG_PASSWORD` (pump), `REDIS_PASSWORD` (redis-exporter), inside `REDIS_URL` (api). `install.sh` always generates it |
| `REDIS_ADDR` | `redis:6379` (redis-exporter) | N | |
| `REDISCLI_AUTH` | prod only, on `redis` | Y | Lets the healthcheck run `redis-cli ping` without `-a` |

Base Redis has no password; it is bound to `127.0.0.1:33003`.

## 8. Observability

| Variable | Default | Component | Purpose |
|---|---|---|---|
| `PROM_RETENTION_SIZE` | `4GB` | prometheus | `--storage.tsdb.retention.size` (retention time is fixed at 15d) |
| `NODE_EXPORTER_LISTEN_ADDRESS` | `172.17.0.1:9100` | node-exporter | Must match the docker0 gateway address |
| `DATA_SOURCE_URI` | `postgres:5432/opengateway?sslmode=disable` (literal) | postgres-exporter | |
| `DATA_SOURCE_USER` | `og_monitor` (literal) | postgres-exporter | |
| `DATA_SOURCE_PASS` | `${PG_EXPORTER_PASSWORD:-}` (prod `:?`) | postgres-exporter | Secret |
| `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL` | `open-gateway-edge`, `http://otel-collector:4317`, `grpc` | edge (Caddy `tracing` uses the OTel SDK env) | Trace export |

The API's OTEL variables are in section 1. Prometheus, blackbox and the collector are configured by files: `observability/prometheus.yml`, `observability/rules/`, `observability/blackbox.yml`, `observability/otel-collector.yaml`.

## 9. Edge and install / deploy

| Variable | Default | Read by | Req | Secret | Purpose |
|---|---|---|---|---|---|
| `EDGE_LAN_IP` | `127.0.0.1` in compose and Caddyfile | edge (`Caddyfile` `{$EDGE_LAN_IP:127.0.0.1}`) | N | N | Host LAN address so the internal CA also issues for `https://<lan-ip>:<port>`. `install.sh` detects it (`ip -4 -o route get 1.1.1.1`) and keeps a hand-edited value on re-run |
| `EDGE_GATEWAY_UPSTREAMS` | `tyk-gateway:8080`; prod overlay `tyk-gateway:8080 tyk-gateway-2:8080 tyk-gateway-3:8080` | edge | N | N | Space-separated data-plane upstreams for port 33005 |
| `EDGE_IMAGE` | none | prod overlay `edge.image` and `prod-preflight` | Y in prod | N | Digest-pinned image `ghcr.io/<owner>/<repo>/edge@sha256:<64 hex>`; a tag is rejected |
| `API_IMAGE` | `open-gateway-api:local` | prod overlay | N | N | Prebuilt API image (else built locally) |
| `WEB_IMAGE` | `open-gateway-web:local` | prod overlay | N | N | Prebuilt web image |
| `EDGE_TLS_PROBE` | `edge:33001` | api | N | N | See section 1 |
| `COOKIE_SECURE`, `TRUST_PROXY_HOPS`, `SPEC_FETCH_ALLOWED_HOSTS`, `TYK_ADMIN_URLS`, `KRATOS_SMTP_URI`, `KRATOS_COOKIE_SECURE`, `NEXT_PUBLIC_GATEWAY_NODE_LOCATIONS` | see above | compose interpolation | N | N | Optional operator overrides in `infra/.env`; `install.sh` never writes them but preserves them |
| `DEFAULT_ADMIN_EMAIL` | `admin@opengateway.io` | `infra/scripts/prod-preflight.sh` | N | N | Seeded admin whose login must fail in prod |
| `REDIS_HOST`, `REDIS_PORT`, `KRATOS_PUBLIC_URL` | `redis`, `6379`, `http://kratos:4433` (compose) | prod-preflight | N | N | Preflight probes |
| `DEBUG`, `VERBOSE` | `0` | `install.sh` | N | N | Also settable via `--debug` / `--verbose` |

### Secrets in `infra/.env` written by `install.sh`

`install.sh` (`MANAGED_SECRETS`, `MANAGED_ENV_KEYS`) writes these keys, generating each only if absent (an existing file is only appended to, and duplicate keys resolve to the last occurrence): `TYK_GW_SECRET`, `JWT_SECRET`, `DB_PASS`, `HYDRA_SECRETS_SYSTEM`, `HYDRA_SECRETS_COOKIE`, `KRATOS_SECRETS_DEFAULT`, `KRATOS_SECRETS_COOKIE`, `KRATOS_SECRETS_CIPHER`, `REDIS_PASSWORD`, `TYK_WEBHOOK_RELAY_SECRET`, `PG_EXPORTER_PASSWORD`, plus non-secret `EDGE_LAN_IP`. Generation (`install.sh`): `JWT_SECRET` via `generate_secret` (`openssl rand -base64 32`); `DB_PASS` via `rand_hex 16`; `TYK_GW_SECRET` and the other hex secrets via `rand_hex 32`; `KRATOS_SECRETS_CIPHER` via `rand_hex 16` (= exactly 32 characters). Quoted values, an `export` prefix or indented keys in a managed line are rejected as errors rather than normalised.

Required vs soft, summarised:

| Variable | Base compose | Prod overlay |
|---|---|---|
| `DB_PASS`, `JWT_SECRET`, `HYDRA_SECRETS_SYSTEM`, `HYDRA_SECRETS_COOKIE`, `KRATOS_SECRETS_DEFAULT`, `KRATOS_SECRETS_COOKIE`, `KRATOS_SECRETS_CIPHER`, `TYK_WEBHOOK_RELAY_SECRET` | required (`:?`) | required |
| `TYK_GW_SECRET` | optional, dev default `tyk-gateway-secret` | must be set and not the default |
| `PG_EXPORTER_PASSWORD` | optional (monitoring fails closed) | required |
| `REDIS_PASSWORD` | ignored | required |
| `EDGE_IMAGE` | ignored | required |

## 10. Host-side (`pnpm dev`) files

`apps/api/.env.local` (written by `install.sh`) and `apps/api/.env.example` point at `localhost` published ports (`DATABASE_URL` -> `localhost:33002`, `REDIS_URL` -> `localhost:33003`, Ory over the edge HTTPS ports for public URLs and loopback HTTP for admin ports 33011/33013/33014/33015). Because the five app ports are HTTPS with the edge's internal CA, a host process needs `NODE_EXTRA_CA_CERTS=$PWD/infra/edge/root.crt`. Note: in this mode `TYK_ADMIN_URL=http://tyk-gateway:8081/tyk` from `install.sh` is a compose hostname, not resolvable from the host, and the control port is not published (see `apps/api/.env.example`).

`apps/web/.env.example` documents `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_KRATOS_URL`, `NEXT_PUBLIC_HYDRA_URL`, `NEXT_PUBLIC_GATEWAY_URL`, `HYDRA_PUBLIC_URL`, `HYDRA_ADMIN_URL`, `KRATOS_INTERNAL_URL`, the two feature flags and `NEXT_PUBLIC_GATEWAY_NODE_LOCATIONS`; `install.sh` writes only the first four plus `HYDRA_*`, `KRATOS_INTERNAL_URL` and `DATABASE_URL` into `apps/web/.env.local`.
