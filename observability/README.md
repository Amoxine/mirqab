# Observability (WP20, OG-OBS-01/02)

Two containers, both `expose:`-only and neither routed through the edge: an **OpenTelemetry
Collector** and **Prometheus**. Grafana and Alertmanager are deliberately absent (§9) — Prometheus'
own rule state is the proof that an alert works, and dashboards-as-code can wait for a viewer who
asked for one.

**No alert is delivered today.** All 66 rules below evaluate and can be read off
`ALERTS{alertstate="firing"}`, but there is still no Alertmanager and no `alerting:` block —
delivery is OG-OBS-04, out of this scope. See `docs/ha-observability/03-dashboards-alerts-and-runbooks.md`
§2 for the routing design once that lands.

| File | What it configures |
|---|---|
| `otel-collector.yaml` | OTLP trace intake; the edge's WAF log → `coraza_rule_detections_total`; collector self-telemetry on `:8888` |
| `prometheus.yml` | Scrape targets (fleet + blackbox) and where the rules live |
| `blackbox.yml` | Blackbox exporter modules: gateway/API/pump/web/identity health, TCP passthrough, OIDC over TLS |
| `rules/open-gateway.yml` | Eleven alert rules, untouched by OG-OBS-01/02: §5's detection signals, plus four that fire when the others cannot |
| `rules/host.yml` | 12 rules: reachability, CPU (+PSI), memory, OOM, disk/inode fill, read-only fs, disk latency, network errors, clock skew, reboot |
| `rules/containers.yml` | 3 rules: expected container missing, OOM-killed, restart loop |
| `rules/services.yml` | 33 rules: edge (incl. 5xx/latency), Tyk nodes, Postgres (incl. connections/locks), Redis (incl. rejects/persistence), backups, Ory (incl. 5xx/Keto latency), API/web, Pump/analytics, OTel collector |
| `rules/monitoring.yml` | 7 rules: Watchdog, target-down, rule-eval failures, series budget, notifications-dropped, inventory drift, monitoring disk |
| `rules/tests/*.test.yml` | `promtool test rules` fixtures, one file per new rule file |

55 new rules, 11 preserved = **66 total** (verify round 2 removed `EdgeCertExpiringSoon` — see
`rules/services.yml`'s comment at the point it used to sit: `tls internal`'s 12-hour leaf makes any
day-scale "expires within N days" threshold permanently true, and R14 is already fully covered by
`EdgeRootCertificateExpiringSoon`/`EdgeCertificateRenewalStalled` in `rules/open-gateway.yml`).
Every new expr uses only ✓/◐ names from
`docs/ha-observability/02-assets-and-signal-catalog.md`, or a metric this task's contracts name as
*proposed* (C4: `apps/api`, C5: textfile) — never an unverified (✗) name. A rule reading a metric
that does not exist yet in this repo (the C4/C5 metrics, `og_expected_container`,
`og_inventory_last_verified_timestamp_seconds`) is written now and stays silent — not firing, not
erroring — until the owning worker's change lands; each says so in a comment at the point it
depends on one.

Neither service publishes a port, so everything below runs from an in-network curl container — the
same pattern the Tyk control API uses:

```bash
NET=opengatewayinfrastructure_open-gateway-network   # docker network ls, it can drift
CURL="docker run --rm --network $NET curlimages/curl:8.15.0"
```

## Metrics

```bash
$CURL -sG --data-urlencode 'query=tyk_http_requests_total' http://prometheus:9090/api/v1/query
$CURL -s  http://prometheus:9090/api/v1/targets?state=active
```

Three scrape targets predate this task:

- **`tyk-pump:9090`** — gateway traffic. The OSS gateway exposes no Prometheus endpoint of its own,
  so every `tyk_*` series arrives through the pump, one purge cycle (10 s) late. Two things about
  it surprise people: `tyk_http_requests_total` is **not** a built-in — it is declared as a
  `custom_metrics` entry in `infra/pump/pump.conf`, because pump 1.17 ships `tyk_http_status`
  instead — and **`tyk_latency` buckets are milliseconds**, so "p95 > 1 s" is `> 1000`. This job now
  also carries `metric_relabel_configs`: `labeldrop: api_name` (tenant free text, forbidden on
  metrics per docs 02 §4) and a belt-and-braces `drop` on the three unbounded per-key/path/client
  families, alongside obs-w4's pump.conf `disabled_metrics`.
- **`api:4000/api/metrics`** — `prom-client`, plus the Redis, node-sync and certificate gauges the
  rules need. The edge answers **404** for this path: it is an internal target, not a published one.
- **`otel-collector:8889`** — the WAF counter.

OG-OBS-01/02 adds the rest, every one carrying the static labels `environment`, `site` (all
`unknown` until the inventory's `file_sd` replaces them, per docs 02 §2):

| Job | Target | Notes |
|---|---|---|
| `prometheus` | `localhost:9090` | self-scrape — feeds MON-03/04/05 |
| `node` | `host.docker.internal:9100` | C6 final (obs-w2): host netns, bound to the docker0 gateway only, not reachable by compose service name — needs `extra_hosts: host.docker.internal:host-gateway` on the prometheus service. **No static `asset_id`** (verify round 2, M7): the C5 textfile metrics collected off this same target carry their own real `asset_id`, and a static one here would collide and get renamed to `exported_asset_id` |
| `cadvisor` | `cadvisor:8080` | `labeldrop: id` (cgroup path); `keep` on `name=~"open-gateway-.*"` (this host runs other compose projects too) — `name` itself is kept |
| `postgres` | `postgres-exporter:9187` | no scrape-side labeldrop (verify round 2, M2 — see below) |
| `redis` | `redis-exporter:9121` | |
| `edge` | `edge:9180/metrics` | C2 (obs-w4) is live as of verify round 2; maps unusual `method` values to `OTHER`, fixed in verify round 2 (M3) to leave series with no `method` label alone — see below |
| `ory-hydra`/`ory-kratos`/`ory-keto` | `edge:9180/ory/<svc>/metrics` | same C2, live |
| `otel-collector-self` | `otel-collector:8888` | needs `otel-collector.yaml`'s new `service.telemetry.metrics` block |
| `tyk-hello` / `tyk-hello-redis` | blackbox → `tyk-gateway:8081/hello` | body-match, not status code (TYK-01/02) |
| `api-health` | blackbox → `api:4000/api/health` | |
| `pump-health` | blackbox → `tyk-pump:8083/health` | |
| `ory-ready` | blackbox → `edge:9180/ory/{hydra,kratos,keto}/health` | C2 is live; not independently re-verified live in verify round 2 (shared stack was mid-restart) |
| `web-login` | blackbox → `web:3000/` | expects **307**, not a followed 200 — see `blackbox.yml`'s `http_2xx_redirect` module comment |
| `oidc` | blackbox → `https://edge:33010/.well-known/openid-configuration` | **data only as of verify round 2 (M4)** — `oidc_discovery` (ca_file-verified), no alert reads it |
| `oidc-availability` | same target as `oidc` | new in verify round 2 (M4) — `oidc_discovery_insecure` (`insecure_skip_verify`), this is what `OidcDiscoveryOrJwksFailing` actually reads, so a fresh install with no exported `root.crt` can't page on trust alone |
| `tcp-33020` | blackbox → `tyk-gateway:6000` | live today; reads `probe_success 0` until a TCP-protocol API def is loaded (see below). **No active rule reads this job** — `TcpPassthroughDown` would fire permanently on today's stack, so it's deferred (see `rules/services.yml`) |

None of the exporter-backed jobs (`node`, `cadvisor`, `postgres`, `redis`, `edge`, `ory-*`,
`otel-collector-self`) have a live target yet — their containers/listeners are other workers' C1/C2
changes. `up{job=...}` for these reads absent, not `0`, until then.

**Verify round 2, M2:** the `postgres` job used to carry `metric_relabel_configs: labeldrop:
application_name|usename`. Removed — `pg_stat_activity_count` carries several OTHER labels too
(`backend_type`, `datname`, `state`, `wait_event`, `wait_event_type`), so dropping only two of them
left two originally-distinct rows collapsing onto the same series at the same timestamp: a
duplicate sample, which makes Prometheus reject the **entire** scrape, not just this one metric.
The cardinality policy (02 §4: both labels are free-text-shaped) is enforced in PromQL instead —
`PostgresConnectionsHigh` already does `sum(pg_stat_activity_count)` with no `by`, which aggregates
every label away at query time without ever touching the raw scraped series.

**Verify round 2, M3:** the `edge` job's method-mapping relabel used to stamp `method="OTHER"` onto
series that never had a `method` label at all (`caddy_config_last_reload_successful`,
`caddy_reverse_proxy_upstreams_healthy`), because the old rule tested `__tmp_method_known` in
isolation and that label reads empty both for "unusual method" and "no method label". Fixed by
joining `method` and `__tmp_method_known` with a separator (`;`) and matching `.+;` — only true
when `method` is non-empty AND `__tmp_method_known` is empty. Proved in a throwaway lab (a static
fixture with three cases — no `method` label, `method="GET"`, `method="FOOBAR"` — scraped by a
temporary Prometheus with the exact relabel rules): the no-`method` series stayed untouched,
`GET` stayed `GET`, `FOOBAR` became `OTHER`, and no `__tmp_method_known` leaked into any result.

## Blackbox

`blackbox.yml`'s modules are validated in two ways: `--config.check` (syntax) and a read-only probe
against the actual running stack from a throwaway container on the live network (never against the
`open-gateway-*` containers themselves — GET requests only, nothing started, stopped or written).

Verified `probe_success 1` against the live stack, 2026-09-27:

- **`tyk-hello`, `tyk-hello-redis`** — both match the real `/hello` body. **Verify round 2
  correction:** docs 02/03 claim `/hello` "returns 200 even when Redis alone is down", implying the
  top-level `status` stays `pass`. Lab-captured on an isolated v5.15.0 + redis:7-alpine pair (own
  network, Redis stopped and GET repeated until the internal health-check ticker caught up): the
  top-level `status` goes to `"fail"` too, in the SAME response that carries
  `details.redis.status:"fail"` — HTTP is still 200 throughout. So `tyk_hello` alone already detects
  a Redis-down node; `tyk_hello_redis` isn't catching something `tyk_hello` misses, it's naming
  Redis specifically as the cause. Both rules are kept (see `TykNodeDown`/`TykNodeRedisFailing` in
  `rules/services.yml`), with descriptions corrected to match.
- **`api-health`, `pump-health`** — both live and healthy.
- **`web-login`** — reads the first-hop **307**, by module design. Following the redirect (the
  original ask) fails from inside the docker network: `GET /` → `/oauth2/authorize?return_to=%2F` →
  Hydra's *public*, browser-facing URL, `https://localhost:33010/...`. `localhost` resolves to the
  browser's own machine, not the edge — a real vantage point outside the network, which is what
  APP-03's "expect 200" assumes. blackbox always runs in-network (same as every other probe here),
  so `http_2xx_redirect` does not follow redirects and accepts `[200, 307]` — matching docs 02
  APP-03's own text, "every path answers 307".
- **`oidc`** — the `Host: localhost` header, `tls_config.server_name: localhost` and `ca_file`
  against `/etc/blackbox/edge/root.crt` all work together against the edge's existing `:33010`
  listener (this is not the new C2 `:9180` listener — Hydra's public port has been reachable this
  way since WP26b). The blackbox container mounts the whole `./edge` directory at
  `/etc/blackbox/edge:ro`, not the file directly (C1, obs-w2) — `root.crt` is per-install and
  git-ignored, and bind-mounting a single missing file makes Docker create a directory there
  instead, which breaks edge-healthcheck the same way (`infra/edge/README.md`). **Verify round 2
  (M4): this job is now DATA ONLY** — a fresh install with no exported `root.crt` would otherwise
  make `OidcDiscoveryOrJwksFailing` (critical) fire forever on trust alone. The alert now reads the
  new `oidc-availability` job (`oidc_discovery_insecure` module, `insecure_skip_verify: true`)
  instead; this verified module stays queryable but nothing alerts on it.

Verified `probe_success 0`, and expected to be for now:

- **`ory-ready`** — obs-w4's `:9180` internal listener (C2) is in `infra/edge/Caddyfile` as of this
  round. Not independently re-verified live in verify round 2 — the shared stack was mid-restart
  with `edge`/`api`/`web`/Ory containers stuck at `Created` (another worker's in-flight change,
  restarting it is out of scope here). **Validated by config only** in this pass; re-probe once the
  stack is stable.
- **`tcp-33020`** — the port mapping and network path are both fine (`tyk-gateway:6000` is reachable
  from inside the network regardless of the host-side `33020:6000` mapping); there is simply no
  TCP-protocol API definition loaded on this gateway right now (WP27's `protocol: tcp` defs are
  created through the API, never seeded by default — `apps/api/src/modules/api-management/services/tyk-mappers.ts`).
  No listener exists on `:6000` until one is created. This will read `1` the moment a demo/test TCP
  API is provisioned.

Deliberate failure, to prove the wrong-body-regex path actually fails closed rather than passing by
accident: a throwaway `tyk_hello`-shaped module with
`fail_if_body_not_matches_regexp: ['"status":"this-will-never-match"']`, probed against the same
live, genuinely-200 `/hello` endpoint — `probe_http_status_code 200`, `probe_success 0`.

## Alerts

```bash
$CURL -sG --data-urlencode 'query=ALERTS{alertstate="firing"}' http://prometheus:9090/api/v1/query
$CURL -s  http://prometheus:9090/api/v1/rules
```

### Applying a rule change

**Editing `rules/` does nothing on its own.** Prometheus reads the rule files once at start, so a
committed rule can exist in git and nowhere else — which is exactly what happened to the four rules
below on the commit that added them. The directory is bind-mounted, so no rebuild is needed, only a
reload:

```bash
docker kill --signal=HUP open-gateway-prometheus
$CURL -s http://prometheus:9090/api/v1/rules    # confirm the new count, and health=ok
```

A reload that fails to parse keeps the previous rules rather than leaving Prometheus with none.
Immediately after a reload the API may report health `unknown` for a rule that has not been
evaluated yet — that is pre-first-evaluation, not an error; it settles to `ok` within one
`evaluation_interval`.

`POST /-/reload` answers **403** here and always will: `--web.enable-lifecycle` is deliberately not
set (`infra/docker-compose.yml`). Prometheus is unauthenticated on this network — which is why it is
on the SSRF denylist — and that flag would expose `POST /-/quit` alongside the reload endpoint,
making a remote shutdown reachable by anything that can route to it. SIGHUP needs Docker access
instead of network access, which is the distinction worth keeping.

`rules/open-gateway.yml` carries the reasoning for each rule. Two are worth repeating here because
they are not what the roadmap assumed:

- **`RedisEvictingKeys` cannot fire in steady state.** The instance runs `noeviction`, so
  `evicted_keys` is pinned at 0 by configuration. That is the point — it fires only if someone
  changes the policy, which is the condition R3 wants to hear about.
- **`EdgeRootCertificateExpiringSoon` watches the ROOT, not the served certificate.** Caddy's
  `tls internal` issues 12-hour leaves off a 7-day intermediate, so a 14-day threshold on either
  would be permanently firing. It reads `infra/edge/root.crt`, which must exist and be
  world-readable — see `infra/edge/README.md`.

### The four rules that watch the other seven

`MetricsService` **resets** a gauge family when its probe fails, rather than leaving a stale value —
a stale number lies to a rule that cannot tell stale from current. The cost is that in PromQL a
missing series makes the whole expression yield an empty vector, so the rule over it does not fire,
it goes **silent**, which reads exactly like health:

```
(edge_certificate_expiry_timestamp_seconds{role="nonexistent"} - time())
  / edge_certificate_lifetime_seconds{role="nonexistent"} < 0.25    ->  0 results
```

So every rule above had a failure mode in which it reports nothing. The sharpest was R14's own
scenario: an unreachable edge drops the leaf gauges and `EdgeCertificateRenewalStalled` stops
evaluating — **the edge being down produced no alert at all**, while `up{job="open-gateway-api"}`
stayed 1, because Prometheus scrapes the api directly and never touches the edge.

`MetricsTargetDown`, `EdgeCertificateMetricsAbsent`, `RedisMetricsAbsent` and
`GatewaySyncMetricsAbsent` close that. Two things about them worth knowing before editing:

- **The three `absent()` rules are gated on `up{job="open-gateway-api"} == 1`.** These gauges are
  exported *by* the api, so without the gate one api outage fires all four at once for a single root
  cause. With it, `MetricsTargetDown` owns "the api is gone" and each `absent()` rule means the
  narrower, separately actionable "the api is up but this probe inside it is failing". Verified: with
  the api target dead, only `MetricsTargetDown` fires.
- **There is deliberately no `absent(coraza_rule_detections_total)`.** That counter legitimately has
  no series until the first WAF detection, so an absence alert on it would fire on every clean stack.
  An alert that is wrong at rest is worse than the gap it closes.

## Traces

A request through the edge produces one trace spanning **edge → gateway → api → postgres**. That
full chain holds for an API whose upstream is the control plane itself; a normal API's trace stops
at the gateway span, because a third-party upstream has no OTel SDK in it.

The edge starts the trace (Caddy's `tracing` directive) and injects the W3C `traceparent`; Tyk
continues it; the API's SDK continues it again and Prisma hangs the `prisma:engine:db_query` span
underneath. The trace id is on the edge's access-log line as an explicit field:

```bash
docker logs open-gateway-edge | grep http.log.access | tail -1   # -> traceparent, request_id
docker logs open-gateway-otel-collector | grep <trace id>
```

There is no trace backend yet, so the collector's stdout is the store (`debug` exporter, verbosity
`detailed`, with a capped log driver). When a viewer is wanted, add a Tempo/Jaeger exporter to the
`traces` pipeline — nothing else changes.
