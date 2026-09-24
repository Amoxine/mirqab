# Deployment Guide

> Production deployment for Open Gateway — SaaS Admin Dashboard for Tyk OSS

## Table of Contents

1. [Environments](#environments)
2. [Docker Deployment](#docker-deployment)
3. [Tyk Gateway Integration](#tyk-gateway-integration)
4. [Environment Configuration](#environment-configuration)
5. [Database Migrations in Production](#database-migrations-in-production)
6. [Backup Strategy](#backup-strategy)
7. [Monitoring with OpenTelemetry](#monitoring-with-opentelemetry)
8. [CI/CD Pipeline](#cicd-pipeline)
9. [Production Checklist](#production-checklist)

---

## Environments

| Environment | Branch | URL Pattern | Purpose |
|-------------|--------|-------------|---------|
| **Development** | Any feature branch | `localhost:33000` / `localhost:33001` | Local development and testing |
| **Staging** | `main` | `staging.open-gateway.example.com` | Pre-production integration testing |
| **Production** | `release/*` or tagged commits | `open-gateway.example.com` | Live production traffic |

---

## Docker Deployment

### Local Development

```bash
# Start all services (PostgreSQL, Redis, API, Web)
pnpm infra:up

# Or start only infrastructure
docker compose -f infra/docker-compose.yml up -d postgres redis

# Start only applications
docker compose -f infra/docker-compose.yml up -d api web

# View logs
pnpm infra:logs

# Stop all services
pnpm infra:down
```

### Production Docker Compose

Create a `docker-compose.prod.yml` file on your production server:

```yaml
name: open-gateway-production

services:
  postgres:
    image: postgres:16-alpine
    restart: always
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - internal
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: always
    command: >
      redis-server
      --appendonly yes
      --maxmemory 256mb
      --maxmemory-policy allkeys-lru
      --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis_data:/data
    networks:
      - internal
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  api:
    image: ghcr.io/open-gateway/api:latest
    restart: always
    environment:
      NODE_ENV: production
      PORT: 4000
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:33002/${POSTGRES_DB}?schema=public
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:33003
      # Required, no default: the API refuses to start on a placeholder or short value
      JWT_SECRET: ${JWT_SECRET:?set JWT_SECRET (openssl rand -hex 32)}
      JWT_EXPIRES_IN: 15m
      JWT_REFRESH_EXPIRES_IN: 7d
      CORS_ORIGINS: https://open-gateway.example.com
      TYK_ADMIN_URL: ${TYK_ADMIN_URL}           # control-API port, e.g. http://tyk-gateway:8081/tyk
      TYK_ADMIN_SECRET: ${TYK_ADMIN_SECRET}
      TYK_GATEWAY_URL: ${TYK_GATEWAY_URL}       # /hello lives on the control port too
      TYK_ORG_ID: ${TYK_ORG_ID}
      PROXY_DENY_HOSTS: ${PROXY_DENY_HOSTS:-}   # extra hosts an API may never proxy to
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - internal
      - web
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 1G
        reservations:
          cpus: '0.5'
          memory: 256M

  web:
    image: ghcr.io/open-gateway/web:latest
    restart: always
    environment:
      NODE_ENV: production
      NEXT_PUBLIC_APP_URL: https://open-gateway.example.com
      NEXT_PUBLIC_API_URL: https://api.open-gateway.example.com/api
    depends_on:
      - api
    networks:
      - web
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 1G
        reservations:
          cpus: '0.5'
          memory: 256M

  nginx:
    image: nginx:1.25-alpine
    restart: always
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./certs:/etc/nginx/certs:ro
    depends_on:
      - api
      - web
    networks:
      - web

networks:
  internal:
    internal: true
  web:

volumes:
  postgres_data:
    driver: local
  redis_data:
    driver: local
```

### NGINX Reverse Proxy Configuration

Create `nginx.conf`:

```nginx
events { worker_connections 1024; }

http {
    upstream api_backend {
        server api:33001;
    }

    upstream web_backend {
        server web:33000;
    }

    server {
        listen 80;
        server_name open-gateway.example.com api.open-gateway.example.com;
        return 301 https://$host$request_uri;
    }

    server {
        listen 443 ssl http2;
        server_name open-gateway.example.com;

        ssl_certificate     /etc/nginx/certs/fullchain.pem;
        ssl_certificate_key /etc/nginx/certs/privkey.pem;

        location / {
            proxy_pass http://web_backend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }

    server {
        listen 443 ssl http2;
        server_name api.open-gateway.example.com;

        ssl_certificate     /etc/nginx/certs/fullchain.pem;
        ssl_certificate_key /etc/nginx/certs/privkey.pem;

        location /api/ {
            proxy_pass http://api_backend/api/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            # CORS preflight
            if ($request_method = 'OPTIONS') {
                add_header 'Access-Control-Allow-Origin' 'https://open-gateway.example.com';
                add_header 'Access-Control-Allow-Credentials' 'true';
                add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
                add_header 'Access-Control-Allow-Headers' 'Content-Type, Authorization, X-Tenant-ID, X-Correlation-ID';
                add_header 'Access-Control-Max-Age' 86400;
                return 204;
            }
        }
    }
}
```

---

## Tyk Gateway Integration

Open Gateway manages the **open-source Tyk Gateway** through its REST API. The Tyk Dashboard is **not** used or supported (it is proprietary and needs a licence plus MongoDB/Postgres).

### Docker Compose

`infra/docker-compose.yml` already contains the `tyk-gateway` service (Tyk OSS, config via `TYK_GW_*` env vars, API definitions persisted in the `tyk_apps` volume). Set `TYK_GW_SECRET` (in `infra/.env` or the environment) and compose passes the same value to the gateway and to the API:

```yaml
services:
  tyk-gateway:
    image: tykio/tyk-gateway:latest
    environment:
      TYK_GW_LISTENPORT: "8080"
      # Control API (/tyk/*) and /hello on their own port. Publish 8080 only.
      TYK_GW_CONTROLAPIPORT: "8081"
      TYK_GW_SECRET: ${TYK_GW_SECRET:?set TYK_GW_SECRET}
      TYK_GW_USEDBAPPCONFIGS: "false"      # API definitions are files, not Dashboard-managed
      TYK_GW_STORAGE_TYPE: redis
      TYK_GW_STORAGE_HOST: redis
    volumes:
      - tyk_apps:/opt/tyk-gateway/apps

  api:
    environment:
      TYK_ADMIN_URL: http://tyk-gateway:8081/tyk   # control port; note the /tyk suffix
      TYK_ADMIN_SECRET: ${TYK_GW_SECRET}           # sent as x-tyk-authorization
      TYK_GATEWAY_URL: http://tyk-gateway:8081     # /hello moves to the control port
      TYK_ORG_ID: ${TYK_ORG_ID}
```

### Tyk Configuration

- The gateway secret (`TYK_GW_SECRET`, or `"secret"` in `tyk.conf`) must equal the API's `TYK_ADMIN_SECRET`.
- Keep `use_db_app_configs` **false** and persist `/opt/tyk-gateway/apps` (volume or PVC): API definitions are stored there.
- The gateway REST API (`/tyk/*`) must only be reachable from the NestJS pods, never from the internet.
  Set `TYK_GW_CONTROLAPIPORT` (8081 in the compose stack) and publish **only** the data port: on a shared
  port, anyone who can call a published API can also call the admin API. Verified on v5.15.0: with the
  control port set, `:8080` returns 404 for `/tyk/*` **and** for `/hello`, so health probes must target
  the control port (`TYK_GATEWAY_URL`).
- Bind the datastores to loopback (or keep them off the host entirely): the compose stack publishes
  Postgres and Redis as `127.0.0.1:33002` / `127.0.0.1:33003`.
- Request analytics are **not** available from the OSS gateway REST API; see [TYK-LOCAL-DEV.md](TYK-LOCAL-DEV.md#limitations-of-the-open-source-gateway).

---

### Health Check Endpoints

| Service | Endpoint | Type | Interval |
|---------|----------|------|----------|
| API | `GET /api/health` | Liveness + Readiness | 10s |
| Web | `GET /` | Liveness + Readiness | 10s |

---

## Environment Configuration

### Required Production Variables

#### API Server (`apps/api`)

| Variable | Required | Description | Secret |
|----------|----------|-------------|--------|
| `NODE_ENV` | **Yes** | Must be `production` | No |
| `PORT` | No | HTTP port (default: `4000`) | No |
| `DATABASE_URL` | **Yes** | PostgreSQL connection string | **Yes** |
| `REDIS_URL` | **Yes** | Redis connection string | **Yes** (if password) |
| `JWT_SECRET` | **Yes** | JWT signing key, 32+ random chars. No default exists: compose interpolation fails and the API rejects placeholder / short values | **Yes** |
| `JWT_EXPIRES_IN` | No | Access token TTL (default: `15m`) | No |
| `JWT_REFRESH_EXPIRES_IN` | No | Refresh token TTL (default: `7d`) | No |
| `CORS_ORIGINS` | **Yes** | Comma-separated allowed origins | No |
| `COOKIE_SECURE` | No | `true` / `false`: `Secure` flag on the session cookies. Default: `true` only when `NODE_ENV=production`. Set `true` when TLS is terminated in front of an API that does not run `NODE_ENV=production` | No |
| `TRUST_PROXY_HOPS` | No | Number of reverse proxies in front of the API (integer >= 0, default `0`). The rate limiter keys on the client IP; with `0`, X-Forwarded-For is ignored, so behind a proxy all clients share one bucket. Invalid values fall back to `0` with a warning | No |
| `TYK_ADMIN_URL` | **Yes** | Tyk Gateway REST API URL (`<gateway>/tyk`) on the control port, e.g. `http://tyk-gateway:8081/tyk` | No |
| `TYK_GATEWAY_URL` | No | Base URL for the `/hello` probe — the control port, since `/hello` is served there | No |
| `PROXY_DENY_HOSTS` | No | Extra upstream hosts an API may never proxy to (comma separated). Loopback, link-local / cloud metadata and the platform's own service names are always refused | No |
| `TYK_ADMIN_SECRET` | **Yes** | Tyk gateway secret (`TYK_GW_SECRET`) | **Yes** |
| `TYK_ORG_ID` | No | Tyk Organization ID (set on API definitions and on keys) | No |
| `PUMP_HEALTH_URL` | No | Tyk Pump liveness probe, e.g. `http://tyk-pump:8083/health`. Unset = analytics report "pump not running" | No |

#### Web Server (`apps/web`)

| Variable | Required | Description | Secret |
|----------|----------|-------------|--------|
| `NODE_ENV` | No | Must be `production` | No |
| `NEXT_PUBLIC_APP_URL` | **Yes** | Base URL of the web app | No |
| `NEXT_PUBLIC_API_URL` | **Yes** | Backend API base URL | No |

### Secrets Management

| Platform | Recommended Approach |
|----------|---------------------|
| **Docker Compose** | `.env` file with restricted permissions (`chmod 600`) |
| **GitHub Actions** | Repository secrets or OIDC federation to cloud provider |
| **Local Development** | `.env.local` (in `.gitignore`) |

### Secret Rotation

| Secret | Rotation Frequency | Procedure |
|--------|-------------------|-----------|
| `JWT_SECRET` | Quarterly | 1. Generate new secret → 2. Update env var → 3. Rolling restart pods → 4. All users re-authenticate |
| `TYK_ADMIN_SECRET` | Per Tyk policy | 1. Set a new `TYK_GW_SECRET` on the gateway → 2. Update `TYK_ADMIN_SECRET` on the API → 3. Restart gateway, then rolling restart API pods |
| `DATABASE_URL` (password) | Quarterly | 1. Rotate DB password → 2. Update connection string → 3. Rolling restart API pods |
| `REDIS_PASSWORD` | Quarterly | Same as above |

---

## Database Migrations in Production

### Running Migrations

```bash
# 1. Generate Prisma client (always first)
pnpm db:generate

# 2. Run production migrations
DATABASE_URL="${PRODUCTION_DATABASE_URL}" pnpm db:migrate
```

### Zero-Downtime Migration Rules

Follow these rules to deploy without database downtime:

| Operation | Safe? | Procedure |
|-----------|-------|-----------|
| **Add column (nullable/default)** | ✅ Safe | Deploy code + migration together |
| **Add column (NOT NULL, no default)** | ⚠️ Careful | 1. Add nullable → 2. Backfill → 3. Alter to NOT NULL |
| **Add index** | ✅ Safe | Use `CREATE INDEX CONCURRENTLY` for large tables |
| **Remove column** | ⚠️ Careful | 1. Deprecate in code → 2. Remove in next release |
| **Rename column** | ⚠️ Careful | 1. Add new column → 2. Dual-write → 3. Migrate data → 4. Remove old |
| **Remove table** | ⚠️ Careful | 1. Stop using → 2. Verify no queries reference it → 3. Drop |
| **Add enum value** | ✅ Safe | Append-only enum changes are safe |
| **Remove enum value** | ⚠️ Careful | Ensure no rows use the value first |

### Migration Checklist

- [ ] Migration tested on staging with production-like data
- [ ] Migration is backward-compatible (old code still works)
- [ ] Migration includes `@@index` for new query patterns
- [ ] No data loss expected (verify with dry-run)
- [ ] Rollback plan documented (down migration)
- [ ] Prisma client regenerated (`pnpm db:generate`)
- [ ] Deployment order: migration → backend → frontend

---

## Backup Strategy

Scheduled base backups and WAL archiving ship in `infra/docker-compose.yml` (WP29a) — this section
describes what is running, not what someone should build. Everything below has been executed against
this stack; the restore in particular is not a procedure written from the manual.

### What runs

| Piece | Where | What it does |
|---|---|---|
| WAL archiving | `postgres` service, `archive_mode=on` | Every filled (or 5-minute-old) segment is copied to the `pg_wal_archive` volume. `archive_command` refuses to overwrite, so a re-archived segment cannot replace a good one with a partial. |
| Base backups | `postgres-backup` service | `pg_basebackup -Ft -z -Xs` once per `PG_BACKUP_INTERVAL` (default 24 h) into the `pg_backups` volume. `-Xs` makes each backup **self-contained** — restoring it needs no archive. |
| Retention | `infra/scripts/pg-backup.sh` | Keeps `PG_BACKUP_KEEP` (default 7) base backups, then `pg_archivecleanup` drops WAL older than the oldest kept backup's start segment. |
| Liveness | `postgres-backup` healthcheck | Goes unhealthy if `/backups/.last-success` is older than two intervals. Backups stopping is otherwise invisible until the day one is needed. |

`pg_basebackup` opens a **replication** connection, which the postgres image's generated
`pg_hba.conf` never permits from another container. `infra/postgres/pg_hba.conf` exists to add that
one rule (`host replication opengateway all scram-sha-256`) and is otherwise a verbatim copy.

Redis durability is separate and already on: `--appendonly yes` with `appendfsync everysec`
(`infra/docker-compose.yml`). A `compose restart redis` reloads the whole keyspace from the AOF —
verified at WP29a with 93 keys including live `apikey-*` sessions and a `quota-*` counter, all of
which came back byte-identical.

### Restore — to a scratch instance

```bash
infra/scripts/pg-restore-scratch.sh --list     # what is available
infra/scripts/pg-restore-scratch.sh            # latest -> scratch, verify by row count, destroy
infra/scripts/pg-restore-scratch.sh --backup 20260924T172613Z --keep
```

**Use the script, not hand-typed docker commands.** This section used to spell the restore out as
copy-pasteable steps; it is a script now because prose cannot refuse a bad volume name, and
restoring over the primary's data directory is the one mistake here that destroys data
irrecoverably. Before it creates anything, the script refuses a target that names `postgres_data`,
that matches the primary's actual data volume (discovered by inspecting the running container, not
hardcoded), that is already in use by another container, or that already exists.

What it does: extracts `base.tar.gz` + `pg_wal.tar.gz` into a **new** volume, starts a second
postgres against it with `archive_mode=off`, waits for recovery, compares exact row counts for
every table in all four databases against the primary (read-only), prints a per-database verdict,
then destroys the scratch instance. Exit 0 only when every count matches.

`archive_mode=off` is not optional, which is why the script forces it rather than trusting the
operator. Left on, the restored cluster inherits an `archive_command` pointing at a `/wal_archive`
it does not have and jams its own `pg_wal`; given that volume, it would write its segments **over
the primary's archive**.

A mismatch is not automatically a bad backup — a primary that took writes after the backup will
differ, which is why the output names *which* databases differ. `opengateway` matching while the
Ory databases have moved is ordinary traffic; `opengateway` differing is the one worth chasing.

### Point-in-time recovery

Only needed to reach a moment **after** a base backup — undoing a bad migration or a mistaken
delete. Restore as above but from `base.tar.gz` alone (skip `pg_wal.tar.gz`), mount the archive
read-only, and add a `recovery.signal` plus:

```
restore_command = 'cp /wal_archive/%f %p'
recovery_target_time = '2026-09-24 17:30:00+00'
```

Retention bounds how far back this reaches: WAL older than the oldest kept base backup is pruned
with it, so the window is `PG_BACKUP_KEEP × PG_BACKUP_INTERVAL` — seven days at the defaults.

### Schedule and retention

| Data | Frequency | Retention | Where |
|---|---|---|---|
| Postgres base backup | `PG_BACKUP_INTERVAL` (24 h) | `PG_BACKUP_KEEP` (7) | `pg_backups` volume |
| Postgres WAL | Continuous, forced every 5 min | Until the oldest kept base backup no longer needs it | `pg_wal_archive` volume |
| Redis AOF | Continuous, `appendfsync everysec` | Rewritten by Redis | `redis_data` volume |

Both volumes are **local to the host**. Copying them somewhere else is a deployment decision this
repo does not make for you — but a backup that shares a failure domain with its source only covers
the "someone deleted rows" case, not the "the disk died" one.

### Disaster recovery procedure

1. **Stop the writers** — `docker compose -f infra/docker-compose.yml stop api web`. Not `down`,
   and never `down -v`: the volumes are the thing being recovered.
2. **Restore to a scratch instance** and verify it, exactly as above. Confirm the data is what you
   expect *before* anything points at it.
3. **Promote by swapping the volume**, not by restoring in place — stop `postgres`, repoint it at
   the verified scratch volume, start it. An in-place restore destroys the evidence if the backup
   turns out to be the wrong one.
4. **Re-run migrations** — `pnpm db:migrate:deploy`. Idempotent by house rule, so a backup taken
   mid-deploy converges.
5. **Start api and web**, confirm `/api/health` reports postgres, redis and gateway `up`.
6. **Check the gateway's own state** — API definitions live in the `tyk_apps` volumes, not in
   Postgres, so a database restore alone can leave the control plane and the gateway disagreeing.
   `POST /apis/:id/sync` re-pushes; the `GatewayNodesOutOfSync` alert is the signal.

---

## Monitoring with OpenTelemetry

### OTEL Collector Configuration

The OpenTelemetry Collector should be deployed as a DaemonSet in Kubernetes or as a sidecar in Docker:

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
  memory_limiter:
    limit_mib: 512
    spike_limit_mib: 128

exporters:
  prometheus:
    endpoint: 0.0.0.0:8889
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  loki:
    endpoint: http://loki:3100/loki/api/v1/push

service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch, memory_limiter]
      exporters: [prometheus]
    traces:
      receivers: [otlp]
      processors: [batch, memory_limiter]
      exporters: [otlp/tempo]
    logs:
      receivers: [otlp]
      processors: [batch, memory_limiter]
      exporters: [loki]
```

### Key Dashboards (Grafana)

| Dashboard | Purpose | Key Metrics |
|-----------|---------|-------------|
| **API Performance** | Request health | Request rate, p50/p95/p99 latency, error rate (4xx, 5xx) |
| **System Resources** | Infrastructure health | CPU usage, memory usage, disk I/O, network I/O |
| **Database** | PostgreSQL health | Active connections, query latency, cache hit ratio, dead tuples |
| **Redis** | Cache health | Hit rate, memory usage, connected clients, eviction rate |
| **Business Metrics** | Product KPIs | Active tenants, active APIs, total keys, requests per tenant |
| **Tyk Integration** | External dependency | Tyk API call success rate, latency, circuit breaker state |

### Alerts

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| **API Down** | Health check fails for 2 minutes | **Critical** | Auto-restart pods, page on-call |
| **High Error Rate** | 5xx rate > 1% for 5 minutes | **Critical** | Investigate logs, check dependencies |
| **High Latency** | p99 > 2 seconds for 10 minutes | **Warning** | Check database queries, Tyk response times |
| **Database Connections** | > 80% of max connections for 5 minutes | **Warning** | Scale PgBouncer, check connection leaks |
| **Disk Space** | > 85% disk usage | **Warning** | Clean old backups, expand volume |
| **Circuit Breaker Open** | Tyk circuit breaker open for > 5 minutes | **Warning** | Check Tyk Gateway health |
| **JWT Secret Rotation** | JWT secret older than 90 days | **Info** | Rotate secret via scheduled procedure |

---

## CI/CD Pipeline

Both workflows are real files; this section describes what they do rather than restating them, so it
cannot drift the way the Helm-based fiction that used to sit here did.

### CI — `.github/workflows/ci.yml`

Runs on every push to `main` and every pull request. Two jobs.

**`ci`** — Postgres 16 and Redis 7 as services, then, in order and all blocking:

| Step | Notes |
| --- | --- |
| `actionlint` | First, so a broken workflow fails before anything else runs. Runs from the official image pinned **by digest**, which carries shellcheck at a fixed version — see below. |
| `pnpm audit --prod --audit-level=high` | Blocking since WP29b. Previously `continue-on-error`. |
| `pnpm db:generate`, `pnpm db:migrate` | Against the service Postgres. |
| `pnpm typecheck`, `pnpm lint` | |
| Guards | docs paths exist · locale key sets match across en/fr/ar · every dashboard page is permission-gated · **no Helm/Kustomize** (`infra/scripts/check-no-k8s.sh`) |
| `pnpm format:check`, `pnpm test`, `pnpm build` | |
| `pnpm --filter @open-gateway/api test:e2e` | API auth flows, no browser. |

**`edge-image`** — builds `infra/edge` (xcaddy + Coraza) and asserts the pinned module set. Separate
job because it shares nothing with the Node pipeline and should not sit in series with the tests.

#### Why the audit step is blocking now

It carried `continue-on-error: true` because `pnpm audit --prod` reported 34 high advisories. All 34
were transitive and every one had a published fix, so WP29b forced the patched versions through
`pnpm.overrides` in the root `package.json` — 34 → 0.

Read that claim precisely: it is **`pnpm audit --prod --audit-level=high` exits 0**, not "no
vulnerabilities". A low and several moderates remain below this threshold, and `--prod` is doing real
work — the full dev tree still reports criticals and highs from build-time tooling that never ships.
Widening the gate to the dev tree is a separate decision with a different cost. A new high now turns the build red, which is the point. Fix it with an override; if one
genuinely cannot be fixed, that is an owner decision and it belongs in a comment beside the reason,
not behind `continue-on-error`.

#### Why actionlint runs from a pinned image

It used to be `bash <(curl -s https://raw.githubusercontent.com/.../main/scripts/download-actionlint.bash)`
— an unpinned script from a moving branch, piped into a shell with the repository checked out.

It then briefly became a version-pinned, sha256-verified release archive, which was better but still
wrong in a way that shipped a defect: **actionlint runs shellcheck on every `run:` block whenever
shellcheck is on PATH.** It is on `ubuntu-latest` and it was not on the machines that reviewed the
workflow, so a local `actionlint` exited 0 while CI's first step would have failed on SC2016. A
downloaded binary leaves shellcheck runner-provided and unpinned — a second unpinned tool, and the
reason local and CI disagreed.

The job now runs the official image pinned by digest, which carries both at fixed versions. Reproduce
CI exactly, on any machine, before touching a workflow file:

```bash
docker run --rm -v "$PWD:/repo:ro" -w /repo \
  rhysd/actionlint@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 -color
```

To bump: pull the new tag, then take its digest from
`docker buildx imagetools inspect rhysd/actionlint:<VER> --format '{{.Manifest.Digest}}'`.

### CD — staging (`.github/workflows/cd-staging.yml`)

On every push to `main`, in two jobs.

**`build`** builds and pushes three images to GHCR — web, api and **edge** — and exports each one's
**digest** as a job output. The edge is built here rather than on a developer's laptop because it is
the only self-compiled artifact in the stack.

**`deploy`** pipes `infra/scripts/deploy-staging.sh` to the staging host over SSH. That script
checks out the exact commit CI tested (by sha, never `pull --ff-only`), writes the three digests
into `infra/.env`, then `docker compose … pull` followed by `up -d`. Pull before up, so an image
that cannot be fetched fails while the previous stack is still serving.

`prod-preflight` gates the `up`, so a default secret or an `EDGE_IMAGE` that is not digest-pinned
aborts the deploy rather than warning. The health check that follows is a real `curl --fail` retried
for up to 150 s; the job fails if staging never answers.

The deploy job runs only when `vars.STAGING_DEPLOY` is `true`. A fork or a fresh clone has none of
the infrastructure below, and a CD job that fails on every push is a red build everyone learns to
ignore — which is how the health check this replaced came to be an `echo`. When the variable is not
set the run states that images were published and no deployment ran.

#### Repository variables

Variables rather than secrets: these are public URLs that end up inside a client bundle anyone can
read, and `vars` keeps them visible in the run log where a wrong one is diagnosable.

| Variable | Value |
| --- | --- |
| `STAGING_DEPLOY` | `true` to enable the deploy job. Anything else publishes images only. |
| `STAGING_API_URL` | e.g. `https://staging.example.com/api` |
| `STAGING_KRATOS_URL` | e.g. `https://staging.example.com:33012` |
| `STAGING_HYDRA_URL` | e.g. `https://staging.example.com:33010` |
| `STAGING_APP_URL` | e.g. `https://staging.example.com` — also what the health check probes |
| `STAGING_GATEWAY_URL` | e.g. `https://staging.example.com:33005` |

The five URL variables are passed as **build args** to the web image. `NEXT_PUBLIC_*` values are
inlined into the client bundle at build time and are **not** read when the container starts, so
setting them in compose on the staging host does nothing. Left unset, the image ships
`apps/web/Dockerfile`'s localhost defaults and every visitor's browser calls *their own* machine —
which is why the health check now fetches the app and fails if a localhost URL is baked into what
it served.

#### Secrets

All are repository (or `staging` environment) secrets. `GITHUB_TOKEN` is supplied by Actions and
needs no configuration; the workflow narrows its own permissions to `contents: read` +
`packages: write`.

| Secret | What it is | How to produce it |
| --- | --- | --- |
| `STAGING_SSH_HOST` | Hostname or IP of the staging host | — |
| `STAGING_SSH_USER` | User permitted to run `docker compose` there | — |
| `STAGING_SSH_KEY` | Private key, PEM, **no passphrase** | `ssh-keygen -t ed25519 -f deploy_key -N ""`, then append `deploy_key.pub` to that user's `~/.ssh/authorized_keys` |
| `STAGING_KNOWN_HOSTS` | The host's public key | `ssh-keyscan <host>` — **required**, not optional: `StrictHostKeyChecking=accept-new` would trust whatever answered the first connection, which is the one worth attacking |
| `STAGING_PATH` | Absolute path to the checkout on that host | — |
| `STAGING_HEALTH_URL` | URL the health check polls | e.g. `https://staging.example.com/api/health` |

#### Deploying by hand

The same script CD uses, so a manual deploy is not an approximation of it:

```bash
REMOTE_PATH=/srv/open-gateway \
DEPLOY_SHA=$(git rev-parse HEAD) \
WEB_IMAGE=ghcr.io/<owner>/<repo>/web@sha256:… \
API_IMAGE=ghcr.io/<owner>/<repo>/api@sha256:… \
EDGE_IMAGE=ghcr.io/<owner>/<repo>/edge@sha256:… \
  bash infra/scripts/deploy-staging.sh
```

Resolve a digest from a tag with:

```bash
docker buildx imagetools inspect ghcr.io/<owner>/<repo>/edge:<tag> --format '{{.Manifest.Digest}}'
```

### Supply chain: what is pinned, and where

| Artifact | Pin | Where |
| --- | --- | --- |
| Caddy base images (builder + runtime) | **index digest**, not a per-platform one | `infra/edge/Dockerfile` |
| Caddy version compiled by xcaddy | `v2.11.4` | `infra/edge/Dockerfile` |
| `coraza-caddy` | `v2.6.1` — never float it, earlier releases stall SSE and WebSocket | `infra/edge/Dockerfile` |
| OWASP CRS ruleset | `coraza-coreruleset/v4 v4.25.0` — previously arrived transitively and was unnamed | `infra/edge/Dockerfile` |
| The built edge image | **digest**, required, tag refused | `infra/docker-compose.prod.yml` + `infra/scripts/prod-preflight.sh` |
| web / api images | digest when CD sets them, local build otherwise | `infra/docker-compose.prod.yml` |
| `actionlint` + shellcheck | image digest | `.github/workflows/ci.yml` |
| npm dependency tree | `pnpm-lock.yaml` + `pnpm.overrides` | root `package.json` |

The edge Dockerfile asserts its own pins at build time (`caddy build-info` greps), so a pin that
stopped holding fails the build rather than a request weeks later. CI re-runs that build on every
pull request.

### No Kubernetes

This repository is Compose-only (owner decision **O1**). `helm/` and `k8s/` were deleted in WP12b,
and `infra/scripts/check-no-k8s.sh` fails CI if a chart, a `kustomization.yaml` or either directory
reappears. This section previously documented a `helm upgrade` deploy against `infra/helm`, which
had not existed for some time — if Kubernetes is ever adopted, that revisits O1 and deletes the
guard in the same commit.

---

## Production Checklist

Before deploying to production, verify ALL items:

### Infrastructure

- [ ] PostgreSQL 16 running with WAL archiving and scheduled base backups (`postgres-backup`)
- [ ] Redis 7 running with AOF enabled and maxmemory policy
- [ ] TLS serving from the Caddy edge, and its renewal proven — the leaf/intermediate
      fraction-of-lifetime alert is firing-capable (WP29a), not just configured
- [ ] Edge fronting all three gateway nodes with correct upstreams
- [ ] Resource limits set for all containers (CPU, memory)
- [ ] Health checks configured for all services
- [ ] `EDGE_IMAGE` set to the digest CD published — `prod-preflight` refuses a tag

### Security

- [ ] `JWT_SECRET` is a strong random string (32+ characters)
- [ ] `TYK_ADMIN_SECRET` rotated and stored in secrets manager
- [ ] Database password is strong and stored in secrets manager
- [ ] CORS origins whitelist matches production domains only
- [ ] All containers run as non-root users
- [ ] `internal: true` on the Docker network(s) that should not reach the host or the internet
- [ ] Rate limiting: there is no per-endpoint override any more — `POST /auth/login`, `/auth/register` and `/auth/refresh` don't exist in this API (Kratos and Hydra own those flows outside it); every endpoint, including the surviving `GET /auth/me`, gets the single global bucket of 100 requests/min per IP (`NODE_ENV=production`; any other value raises it to 1000/min)
- [ ] `TRUST_PROXY_HOPS` set to the exact number of proxies in front of the API (`1` for the NGINX example above). Left at `0` behind a proxy, every client shares one rate-limit bucket; set too high, clients can spoof `X-Forwarded-For` to dodge the limits
- [ ] Session cookies carry `Secure`: set by `apps/web` (not this API) via `NODE_ENV=production` or `COOKIE_SECURE=true`; verify by completing a login through the dashboard and checking DevTools → Application → Cookies for `Secure` on both `access_token` and `refresh_token`
- [ ] Secret values encrypted at rest (Vault, `.env` on an encrypted volume, or your platform's secret store)

### Application

- [ ] All database migrations applied and tested
- [ ] Default admin user created (password changed from seed)
- [ ] Environment variables validated (no missing required vars)
- [ ] Error pages configured (404, 500)
- [ ] Logging configured (structured JSON, correlation IDs)
- [ ] OpenTelemetry collector running and exporting
- [ ] Grafana dashboards accessible and showing data

### Testing

- [ ] All CI checks pass on `main`
- [ ] Staging deployment verified with end-to-end testing
- [ ] Login flow tested with production auth configuration
- [ ] API creation flow tested end-to-end (create → Tyk sync → display)
- [ ] Key provisioning flow tested (create → hash → display once → store)
- [ ] Tenant isolation verified (user A cannot see user B's data)
- [ ] Audit logs capturing all CRUD operations
- [ ] Tyk circuit breaker tested (simulate Tyk downtime)

### Operations

- [ ] Runbook documented for common failure scenarios
- [ ] On-call rotation configured (if applicable)
- [ ] Status page configured (if public-facing)
- [ ] Backup restore procedure tested within last 30 days
- [ ] Disaster recovery plan documented and reviewed
- [ ] Dependencies scanned for vulnerabilities (npm audit, Trivy)
- [ ] SBOM generated for all container images

### Rollback Plan

- [ ] Previous Docker images tagged and available
- [ ] Database migration rollback tested (down migration)
- [ ] Rollback command documented: re-tag the previous image and `docker compose up -d` (or your platform's equivalent)
- [ ] Estimated rollback time: < 5 minutes
- [ ] Rollback decision criteria defined (error rate > X%, latency > Y)
