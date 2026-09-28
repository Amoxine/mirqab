# Tyk Local Development

> Run the open-source Tyk Gateway locally alongside the full MIRQAB stack.

## Overview

MIRQAB is a dashboard around the **open-source Tyk Gateway**. The **Tyk Dashboard is not used** (it is proprietary and needs a licence plus MongoDB/Postgres). The NestJS API manages the gateway through the Gateway REST API, and the Tyk gateway is part of the base Docker Compose stack.

## Architecture

```
Browser ──► Next.js :33000 ──► NestJS :33001 ──► Tyk Gateway REST API  (<gateway>/tyk)
                                   │                     │
                                   ▼                     ▼
                              PostgreSQL :33002     Tyk Gateway :33005 ──► your upstream APIs
                             (127.0.0.1 only)      (data plane; control API :8081 internal)
                                   ▲                     │
                                   │                     ▼
                               Tyk Pump ◄──────── Redis :33003 (keys, rate limits, quotas,
                            (analytics sink)                    buffered analytics records)
```

Analytics records travel gateway → Redis → **Tyk Pump** → PostgreSQL (`tyk_analytics`,
`tyk_aggregated`), which the API reads directly. See [ANALYTICS-PIPELINE.md](./ANALYTICS-PIPELINE.md).

## Port Mapping

| Service | Container Port | Host Port | Purpose |
|---------|---------------|-----------|---------|
| Next.js Web | 3000 | **33000** | Admin dashboard UI |
| NestJS API | 4000 | **33001** | Backend API server |
| PostgreSQL | 5432 | **127.0.0.1:33002** | Application database + Tyk Pump analytics tables (loopback only) |
| Redis | 6379 | **127.0.0.1:33003** | Cache + sessions + Tyk storage + analytics buffer (loopback only) |
| **Tyk Gateway** (data plane) | 8080 | **33005** | API proxy — your published API traffic |
| **Tyk Gateway** (control API) | 8081 | *not published* | `/tyk/*` **and** `/hello`, reachable only from inside the compose network |
| **Tyk Pump** | 8083 | *not published* | Purges analytics from Redis into PostgreSQL; `/health` probed by the API |
| `tyk-gateway-init` | — | — | One-shot: chowns the gateway's `apps` volume to uid 65532 and leaves a `.keep` in it, then exits 0 |

The control API lives on its own, unpublished port (`TYK_GW_CONTROLAPIPORT: 8081`) so that reaching a
published API does not also mean reaching the gateway's admin API. Verified on v5.15.0: once it is set,
`:8080` answers **404 for `/tyk/*` and for `/hello`** — both are served on `:8081` only.

Pinned images: gateway **`tykio/tyk-gateway:v5.15.0`**, pump **`tykio/tyk-pump-docker-pub:v1.17.0`**.
Never use `:latest` — locally it resolves to a stale 2021 build (v3.0.4).

## Quick Start

```bash
# From project root
docker compose -f infra/docker-compose.yml up -d

# Check all containers are healthy
docker compose -f infra/docker-compose.yml ps

# Gateway health: /hello is on the unpublished control port, so probe it from the API container
docker compose -f infra/docker-compose.yml exec api \
  node -e 'fetch(process.env.TYK_GATEWAY_URL+"/hello").then(r=>r.text()).then(console.log)'
curl https://localhost:33001/api/gateway/status   # same probe, through the API (needs auth)
curl https://localhost:33001/api/health           # NestJS API
open https://localhost:33000                      # Web
```

## Credentials

| Credential | Default | Used By |
|------------|---------|---------|
| Gateway secret | `tyk-gateway-secret` | Gateway `TYK_GW_SECRET`; NestJS sends it as `x-tyk-authorization` (`TYK_ADMIN_SECRET`). Only safe as a default because the control API is not published |
| `JWT_SECRET` | **none — required, but unused** | Compose still refuses to start the API without it, but nothing in the API reads it any more: dashboard tokens are issued by Ory Hydra and verified against its JWKS, not signed here. Left in place as a leftover of the pre-Ory auth system (see `docs/security.md`), not a real credential to manage |
| Organization ID | `org123` | NestJS `TYK_ORG_ID` in API definitions |

Override the secret with `TYK_GW_SECRET` in `infra/.env` (git-ignored). `install.sh` generates a random one there.
Compose passes the same value to the gateway and to the API container, so they always match.

## How NestJS Connects to Tyk

`TykClientService` calls the **Gateway REST API**:

| Variable | Value in Docker | Purpose |
|----------|-----------------|---------|
| `TYK_ADMIN_URL` | `http://tyk-gateway:8081/tyk` | Base URL of the gateway REST API on the control port (note the `/tyk` suffix) |
| `TYK_ADMIN_SECRET` | `$TYK_GW_SECRET` | Sent as `x-tyk-authorization` |
| `TYK_GATEWAY_URL` | `http://tyk-gateway:8081` | Base URL for the `/hello` probe — the control port, since `/hello` moves there |
| `PROXY_DENY_HOSTS` | *(empty)* | Extra upstream hosts `proxyUrl` may never point at; loopback, link-local/metadata and the platform's own service names are always refused |
| `TYK_ORG_ID` | `org123` | Organization id in API definitions and keys (keys created before this was set keep an empty org until their next update) |
| `PUMP_HEALTH_URL` | `http://tyk-pump:8083/health` | Tyk Pump liveness probe for `GET /api/analytics/health` (see `docs/ANALYTICS-PIPELINE.md`) |

Running the API on the host instead of in Docker: the control port is not published, so either add a
mapping for it in a `docker-compose.override.yml` (`"127.0.0.1:33006:8081"`) and use
`TYK_ADMIN_URL=http://localhost:33006/tyk` + `TYK_GATEWAY_URL=http://localhost:33006`, or run the API in
compose. The same applies to `PUMP_HEALTH_URL`: without a published pump port, analytics report
"pump not running".

### API Creation Flow

1. User creates an API in the dashboard → `POST /api/apis` (status `DRAFT`)
2. NestJS saves the `ApiDefinition` in PostgreSQL and syncs it to the gateway (`POST /tyk/apis`)
3. NestJS asks the gateway to reload (`GET /tyk/reload/group`), stores `tykApiId`, sets `syncStatus=SYNCED`
4. User activates the API (`PATCH /api/apis/:id` with `status: ACTIVE`); the gateway starts routing `listenPath` to `proxyUrl`

The gateway keeps API definitions as files in `/opt/tyk-gateway/apps` (the `tyk_apps` volume), so they survive container recreation.

### Key Creation Flow

1. `POST /api/keys` with `apiDefId` (the API must already be synced to the gateway)
2. NestJS creates the key in Tyk (`POST /tyk/keys/create`) with access rights to that API
3. NestJS stores only the SHA-256 hash and returns the raw key **once**
4. Clients call the gateway with `Authorization: <key>`; revoked keys are rejected (403)

### OAuth2 Client Creation Flow (`authType: OAUTH`)

1. `POST /api/oauth-clients` with `apiDefId` (the API must use `authType: OAUTH` and be synced)
2. NestJS registers a `client_credentials` client in Hydra (`POST /admin/clients`), with the tenant in
   `owner` and `{tenantId, apiDefId}` in `metadata` — Hydra is the only store, there is no local table
3. NestJS writes a Tyk policy **whose id is the client id** (`POST /tyk/policies`), granting
   `access_rights` for that one API plus the client's optional rate limit / quota
4. The raw secret is returned **once**, with the token endpoint
5. The consumer exchanges it for a JWT at Hydra's `/oauth2/token` and calls the gateway with
   `Authorization: Bearer <token>`

Tyk resolves the token to its policy through `jwt_policy_field_name: client_id` — the claim Hydra
already puts in every `client_credentials` token — so no Hydra token hook is involved. Revoking
deletes the **policy first**, then the Hydra client: Tyk verifies these tokens offline, so dropping
the policy is what stops tokens that were already issued.

## Limitations of the open-source gateway

- **No analytics API.** `GET <tyk>/analytics` is a Tyk Dashboard feature and does not exist on the OSS gateway. Request metrics therefore come from **Tyk Pump**, which writes the gateway's Redis-buffered records into the `tyk_analytics` and `tyk_aggregated` tables in PostgreSQL; the API queries those directly. Details, schemas and troubleshooting: [ANALYTICS-PIPELINE.md](./ANALYTICS-PIPELINE.md).
- **No container healthchecks for the gateway and pump.** Both images are distroless (uid 65532, no shell, no `wget`/`curl`), so compose healthchecks cannot run inside them. Dependents use `condition: service_started`, and readiness is reported by the app instead: `GET /api/gateway/status` (gateway `/hello` probe) and `GET /api/analytics/health` (pump pipeline).
- **The gateway cannot write API definitions on a fresh volume.** `/opt/tyk-gateway/apps` ships as `root:root` while the process runs as uid 65532, so `POST /tyk/apis` fails with `file object creation failed, write error`. The one-shot `tyk-gateway-init` service chowns the volume to `65532` before the gateway starts — keep it in `depends_on`. It must also leave a file behind (`.keep`): Docker copies the image's directory content into a volume only while that volume is **empty**, so a chown-only init was silently undone on a fresh machine by root-owned `app_sample.json` landing on top of it (measured: chown-only → `/apps` back to `0:0` and uid 65532 gets `EACCES`; chown + `.keep` → stays `65532` and writable).
- **A JWKS URL in `jwt_source` is broken on v5.15.0 — do not "fix" the pinned key back to one.** An `authType: OAUTH` definition carries `jwt_source` as the **base64 PEM** of Hydra's access-token signing key, read per sync from `GET /admin/keys/hydra.jwt.access-token` (the public `/.well-known/jwks.json` also carries the id-token key and does not say which is which). A JWKS **URL** in `jwt_source` verifies exactly one request per gateway start and then answers 403 for every later request, logging `JWKS source decode failed: <url> is not a base64 string` — its JWKS cache read falls back to base64-decoding the URL itself (reproduced 100%, survives a restart). The modern `jwt_jwks_uris` field is not an option either: `getSecretToVerifySignature` only reads it when `config.IsOAS`, and these are classic definitions. base64(JWKS JSON) also fails; only base64(PEM) verifies reliably. **Consequence:** after rotating Hydra's access-token key, re-sync every OAUTH API (`POST /api/apis/:id/sync`) — Hydra does not rotate on its own. See `apps/api/src/modules/api-management/services/hydra-signing-key.ts`.
- **Policies need a writable directory.** `POST /tyk/policies` answers 500 `Failed to create file!` unless `TYK_GW_POLICIES_POLICYPATH` points at one, so the gateway mounts the `tyk_policies` volume at `/opt/tyk-gateway/policies` and `tyk-gateway-init` chowns it exactly like `/apps`. `POST` is an upsert (it truncates `<policy id>.json`), and `GET /tyk/reload/group` applies a create or a delete without a restart — but only **schedules** it, so the API polls `GET /tyk/policies/<id>` until the change is live, otherwise a new client is refused for ~300ms and a revoked one keeps working. The image ships a sample `policies.json` into the volume; it grants a non-existent API in another org and nothing maps to it.
- **`authType: JWT` (bring-your-own issuer) is still unmapped.** It sets `enable_jwt` with no signing key and no policy mapping, so such an API would reject every request. It is deliberately not offered in the dashboard form — use `NONE`, `AUTH_TOKEN` or `OAUTH`.

## Troubleshooting

### Tyk Gateway Won't Start

```bash
docker logs open-gateway-tyk-gateway
docker logs open-gateway-tyk-init                     # must exit 0 before the gateway starts
docker compose -f infra/docker-compose.yml ps redis   # the gateway needs a healthy Redis

# /hello lives on the control port (8081), which is not published — ask from inside the network
docker compose -f infra/docker-compose.yml exec api \
  node -e 'fetch("http://tyk-gateway:8081/hello").then(r=>r.text()).then(console.log)'
# {"status":"pass","version":"5.15.0",...}
```

The gateway has no healthcheck (distroless image), so `docker compose ps` shows it as `running`
rather than `healthy` — that is expected. Use `/hello` or `GET /api/gateway/status` instead.

### Analytics Stay Zero

```bash
docker compose -f infra/docker-compose.yml logs tyk-pump | grep -E "Init Pump|error"
curl -s -b /tmp/og.jar https://localhost:33001/api/analytics/health
```

Full decision table in [ANALYTICS-PIPELINE.md](./ANALYTICS-PIPELINE.md#debugging-an-empty-pipeline).

### NestJS Can't Reach Tyk

```bash
docker exec open-gateway-api wget -qO- http://tyk-gateway:8081/hello
docker exec open-gateway-api env | grep TYK

# Gateway REST API with the secret (expect 200 and a JSON list). Not reachable from the host:
# 33005 is the data plane and answers 404 for /tyk/*.
docker compose -f infra/docker-compose.yml exec api sh -c \
  'wget -qO- --header="x-tyk-authorization: $TYK_ADMIN_SECRET" "$TYK_ADMIN_URL/apis"'
```

A `403` from the gateway REST API means the secret differs between the gateway and the API: recreate both with `docker compose -f infra/docker-compose.yml up -d`.

### Sync Status FAILED

The API definition is stored in PostgreSQL but the gateway sync failed (gateway down or wrong secret). Fix the cause and update the API again (`PATCH /api/apis/:id`) to re-sync. Without a running gateway everything else keeps working; only the sync fails.

### Port Conflict

Change the host port mapping of `tyk-gateway` in `infra/docker-compose.yml` (`"33005:8080"`). Do not
publish `8081`: that is the control API.

## Stopping

```bash
docker compose -f infra/docker-compose.yml down       # keep data volumes
docker compose -f infra/docker-compose.yml down -v    # also delete Postgres/Redis/Tyk data
```
