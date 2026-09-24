# Edge — TLS termination + WAF

One Caddy publishes all five application ports as HTTPS listeners, on the same port numbers the
stack used before. Nothing else publishes: `web`, `api`, `tyk-gateway`, `hydra` and `kratos` carry
`expose:` in `docker-compose.yml`, so the only way in is through here.

| URL | Upstream |
|---|---|
| `https://localhost:33000` | `web:3000` |
| `https://localhost:33001` | `api:4000` |
| `https://localhost:33005` | `tyk-gateway:8080` (data plane) |
| `https://localhost:33010` | `hydra:4444` (OAuth2 public) |
| `https://localhost:33012` | `kratos:4433` (self-service public) |

Every URL is the old one with `http` → `https`. Nothing else moved.

**Not routed, deliberately:** the Tyk control API (`8081`), Prometheus (`9090`, arrives with WP20)
and the Ory admin APIs (`33011` / `33013`). The Ory admin APIs are unauthenticated and stay bound to
`127.0.0.1`; the control API is not published at all. A request for any of them through the edge
gets a 404 from Caddy's default handler. Do not add a site for one.

`Caddyfile` is operator configuration — there is no UI, no API route and no permission for it.

## Single-edge contract (WP29a)

There is **one** edge and it fronts 100 % of traffic, so it is a single point of failure. That is a
decision, not an oversight, and this section is the other half of it: the alternative — a second
Caddy — needs either the `caddy_data` volume shared between two containers (two processes writing
one CA store and one cert cache) or the internal CA re-exported into the second instance, plus a
load balancer in front of the pair that is then itself the new SPOF. Real complexity, for an outage
window measured below in **single-digit seconds**. The restart contract wins until there is a
second host to put the second edge on, at which point the load balancer is somebody else's.

**Downtime window: ~4.5 s**, measured, not estimated. A 20 Hz prober against
`https://localhost:33001/api/health` across `compose restart edge` saw 16 consecutive failures
spanning 3.6 s, with the first success 4.5 s after the first failure. `compose restart` itself
returns in ~4.4 s.

**Procedure — config change (zero downtime):**

```bash
# 1. Validate BEFORE touching the running container. A Caddyfile that fails to parse takes the
#    edge down on restart and the error only appears afterwards.
docker run --rm -v "$PWD/infra/edge/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -e EDGE_LAN_IP=127.0.0.1 open-gateway-edge:wp26b caddy validate --config /etc/caddy/Caddyfile

# 2. Reload in place — no listener is dropped, no connection is broken.
docker compose -f infra/docker-compose.yml exec edge caddy reload --config /etc/caddy/Caddyfile
```

A reload covers every Caddyfile change. A **restart** is only needed when the compose service
itself changes — a new environment variable, a new volume, a new image — and that is the 4.5 s case:

```bash
docker compose -f infra/docker-compose.yml up -d edge
# healthy again in ~7s by compose's own reckoning (the healthcheck interval rounds up the 4.5s)
```

**Health signals — two, deliberately:**

| Check | Where | Catches | Misses |
|---|---|---|---|
| `edge` healthcheck | in-container, Caddy admin API on `127.0.0.1:2019` | the process died or dropped its config | anything about TLS — it answers 200 while every handshake fails |
| `edge-healthcheck` sidecar | `curlimages/curl`, over the network, real HTTPS | TLS handshake failure, an unreachable edge, an expired or unissuable leaf | nothing the first one catches |

The sidecar is not a duplicate. `tls internal` issues its 12-hour leaves **lazily, at handshake
time**, so a broken CA or a stalled renewal is invisible to a probe that never performs a handshake
— which is exactly R14's silent-failure mode. Verified: with the edge up the sidecar's command
exits 0; against an unreachable port it exits 7; against a certificate the CA it verifies with did
not sign, 60. The in-container admin-API probe exits 0 in all three.

Renewal itself is watched by `EdgeCertificateRenewalStalled` (`observability/rules/`), which alerts
on the **fraction of lifetime remaining** rather than a day count — a 12-hour certificate cannot be
watched any other way.

**When the edge is down**, nothing is reachable: web, api, the gateway data plane, Hydra and Kratos
all publish through it and nothing else publishes at all. The one exception is the TCP passthrough
port `33020`, which Tyk binds directly (WP27) and which an edge outage does not touch.

## Trusting the CA (one-time, per client machine)

`tls internal` means Caddy runs its own CA, which signs for `localhost` and for the host's LAN
address. Export the root once, then install it wherever a browser or a `curl` has to talk to this
stack:

```bash
docker compose -f infra/docker-compose.yml cp \
  edge:/data/caddy/pki/authorities/local/root.crt infra/edge/root.crt
chmod 644 infra/edge/root.crt
```

The `chmod` is not cosmetic: `cp` preserves Caddy's 0600, and the `api` container reads this file as
uid 1001 for WP20's certificate-expiry gauge. Left at 0600, the gauge is silently absent and the
`EdgeRootCertificateExpiringSoon` rule has nothing to evaluate — see `observability/rules/`.

`infra/edge/root.crt` is **git-ignored on purpose**: the CA's private key lives in the `caddy_data`
volume of whichever machine ran the stack first, so committing one install's root would ask everyone
else to trust a CA somebody else holds the key to. Every install exports its own.

Install it:

```bash
# Fedora / RHEL
sudo cp infra/edge/root.crt /etc/pki/ca-trust/source/anchors/open-gateway-edge.crt
sudo update-ca-trust

# Debian / Ubuntu
sudo cp infra/edge/root.crt /usr/local/share/ca-certificates/open-gateway-edge.crt
sudo update-ca-certificates

# macOS
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain infra/edge/root.crt
```

Firefox keeps its own trust store — import it under Settings → Privacy & Security → Certificates →
View Certificates → Authorities.

Then, with no `-k`:

```bash
curl -sS https://localhost:33001/api/health
```

Without installing it, `curl --cacert infra/edge/root.crt https://localhost:33001/api/health` works
too, and is the right form inside scripts.

## LAN access

Set `EDGE_LAN_IP` in `infra/.env` to the host's LAN address before first boot and the certificate
covers `https://<that-ip>:<port>` as well. Unset, the listeners answer on loopback only.

## WAF

OWASP Coraza with CRS 4, compiled into the Caddy binary (`load_owasp_crs`), at **paranoia level 1**
and **`SecRuleEngine DetectionOnly`** — it evaluates every rule and logs every hit, and blocks
nothing. Rule hits land in the container log as JSON audit records:

```bash
docker compose -f infra/docker-compose.yml logs edge | grep transaction
```

The flip to `SecRuleEngine On` belongs to WP20's exit, not here: a block never reaches Tyk, so it
produces no analytics row and is invisible until WP20's block-rate counter exists.

**Body limit: 10 MB** (`SecRequestBodyLimit` / `SecRequestBodyNoFilesLimit` = `10485760`). One
constant, in `Caddyfile`. WP15a caps every per-API request-size limit at or below it so the gateway
is always the smaller enforcer; moving this number means moving that bound in the same commit.

## Rebuilding

The binary is the stack's only self-compiled artifact — Coraza is a Go module and has to be linked
in. Versions are pinned in `Dockerfile` (`coraza-caddy` at `>= 2.6.1`, which is where `Flush()` and
WebSocket hijack were fixed through the response-writer `Unwrap` chain — SSE and long-poll stall on
anything older). WP29b digest-locks the produced image and reproduces the build in CI.

```bash
docker compose -f infra/docker-compose.yml up -d --build edge
```
