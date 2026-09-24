# Observability (WP20)

Two containers, both `expose:`-only and neither routed through the edge: an **OpenTelemetry
Collector** and **Prometheus**. Grafana and Alertmanager are deliberately absent (§9) — Prometheus'
own rule state is the proof that an alert works, and dashboards-as-code can wait for a viewer who
asked for one.

| File | What it configures |
|---|---|
| `otel-collector.yaml` | OTLP trace intake; the edge's WAF log → `coraza_rule_detections_total` |
| `prometheus.yml` | Scrape targets and where the rules live |
| `rules/open-gateway.yml` | Eleven alert rules: §5's detection signals, plus four that fire when the others cannot |

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

Three scrape targets:

- **`tyk-pump:9090`** — gateway traffic. The OSS gateway exposes no Prometheus endpoint of its own,
  so every `tyk_*` series arrives through the pump, one purge cycle (10 s) late. Two things about
  it surprise people: `tyk_http_requests_total` is **not** a built-in — it is declared as a
  `custom_metrics` entry in `infra/pump/pump.conf`, because pump 1.17 ships `tyk_http_status`
  instead — and **`tyk_latency` buckets are milliseconds**, so "p95 > 1 s" is `> 1000`.
- **`api:4000/api/metrics`** — `prom-client`, plus the Redis, node-sync and certificate gauges the
  rules need. The edge answers **404** for this path: it is an internal target, not a published one.
- **`otel-collector:8889`** — the WAF counter.

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
