# Production go-live runbook

> **Scope and honesty.** This was written from the repository, not from a deployment. Nothing in it has been
> run against a real host, domain, certificate authority or SMTP provider. A step that reuses a command
> `install.sh` or `infra/scripts/deploy-staging.sh` already runs says so; anything unverified is marked.
> What the compose files contain is described in [reference/infrastructure.md](reference/infrastructure.md);
> variables in [reference/configuration.md](reference/configuration.md).

Production is `infra/docker-compose.yml` with `infra/docker-compose.prod.yml` layered on top and
`--profile multinode` (three gateway nodes on one host). Everything below runs from the repository root on
the deploy host. **Production publishes exactly five compose ports**, the edge's: 33000, 33001, 33005, 33010
and 33012. Postgres, Redis and every Ory admin API are reachable only from inside the stack.

Two things that sentence does not cover:

- **node-exporter is not a compose port.** It runs in the host network namespace and listens on the docker0
  gateway address (`172.17.0.1:9100` by default, `NODE_EXPORTER_LISTEN_ADDRESS`). That is not the LAN and not
  loopback, but it is a listener on the host, and `check-prod-ports.sh` cannot see it because `docker compose
  config` does not list host-network services' sockets. Confirm it with `ss -ltnp | grep 9100` on the host.
- **Never run `install.sh` or `rebuild.sh` on a production host.** Both use the base compose file alone, and
  `rebuild.sh` also forces `--profile dev`: they would recreate the stack without the overlay, with the
  development ports, a dev Mailpit and no preflight. They exist for a development machine. Production moves
  only through the `"${C[@]}"` commands below or `infra/scripts/deploy-staging.sh`.

## 1. Inputs only the owner can provide

None of these has a safe default, and none should be guessed: a wrong guess does not fail at start-up, it
fails for users (mail that never arrives, a login that redirects to `localhost`, alerts nobody reads).

| Input | Where it lands | Why it cannot be defaulted |
|---|---|---|
| **Public hostnames** for the dashboard (`web`), the API, Hydra public (the OIDC issuer), Kratos public and the gateway data plane. The product docs are served by `web` itself (`apps/web/src/app/docs`), so they need no hostname of their own unless you want one. | Section 4: Caddyfile, `kratos.yml`, `hydra.yml`, compose, web image build args, CD variables | Every one is `localhost:330xx` today and is baked into images, Ory config and cookies |
| **Hostname layout**: one hostname with five ports (as today), or one hostname per service | Section 2 | It decides whether session cookies reach the API at all |
| **Certificate source** for those hostnames | `infra/edge/Caddyfile`, and the ports the edge publishes | The edge signs with its own CA (`tls internal`) today |
| **SMTP provider** and the **sender domain** | `KRATOS_SMTP_URI` in `infra/.env`; `courier.smtp.from_address` in `infra/ory/kratos/kratos.yml` (today `no-reply@open-gateway.local`) | The provider must be allowed to send for that domain: the SPF and DKIM DNS records are yours to publish. Without working mail nobody can recover a password or verify an address, and Kratos reports no error |
| **Deploy host** and **CD target**: SSH host, user, checkout path, and the GitHub variables and secrets in section 3, step 9 | GitHub repository settings; `infra/scripts/deploy-staging.sh` | Only a staging workflow exists (`.github/workflows/cd-staging.yml`). A production workflow, or a manual deploy of the same script, is your decision |
| **Who receives alerts**, and over what channel | Nothing consumes them yet (section 5, gap 1) | There is no Alertmanager, so no receiver exists to configure |
| **The first administrator**: an email address and where its password is kept | `ADMIN_EMAIL` and `ADMIN_PASSWORD` at seed time (step 7) | The seed refuses to run without them |
| **Where backups go off the host** | Not implemented (section 5, gap 8) | Base backups live in a Docker volume on the same machine as the database |

## 2. Decide first: hostnames, cookies and certificates

Two things in the current design only work because everything shares the host `localhost`.

**Session cookies are host-only.** `apps/web` sets `mq_access_token` and `mq_refresh_token` with no `Domain`
attribute (`apps/web/src/lib/oauth-cookies.ts`), and the API authenticates from the `mq_access_token`
cookie (`apps/api/src/modules/auth/strategies/jwt.strategy.ts`). Cookies are not scoped by port, so on
`localhost` the dashboard on `:33000` and the API on `:33001` share them. Two layouts follow:

- **One hostname, five ports** (`https://<host>:33000` web, `:33001` api, `:33005` gateway, `:33010` Hydra,
  `:33012` Kratos). The cookie behaviour is the same as today. This is the layout the Caddyfile already
  has; only the hostnames change.
- **A hostname per service** (`app.`, `api.`, `auth.`...). A cookie set by `app.` is not sent to `api.`
  unless it carries `Domain=<parent>`, which needs a change in `apps/web`. That change is not made here and
  has not been tried.

**The edge publishes only 33000, 33001, 33005, 33010 and 33012, and signs with its own CA.** For public
hostnames you need certificates browsers already trust. Caddy can obtain them itself, but ACME validation
happens on ports 80 and 443 (general ACME behaviour; not tested here), and the edge publishes neither. Its
image is built with only the Coraza WAF modules (`infra/edge/Dockerfile`), so a DNS-challenge provider is not
available either. The choices are: publish 80 and 443 on the edge and let Caddy issue; terminate TLS in
front of the edge with your own load balancer or CDN; or install your own CA's certificate and key into the
edge. Whichever is chosen, replace `tls internal` in `infra/edge/Caddyfile` (the `edge_site` snippet, the
`33005` site and the catch-all site each carry one). Publishing 80 and 443 would add ports to the list above;
`infra/scripts/check-prod-ports.sh` then needs its expected list changed in the same commit.

## 3. Steps

All commands assume this, in the shell you deploy from (bash or zsh):

```bash
C=(docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml --profile multinode)
```

**Requirements.** Docker Engine with the Compose v2 plugin at **version 2.24 or later**: the overlay uses the
`!reset` YAML tag, and what an older Compose does with it is unverified (it may drop the tag without
clearing anything, which would publish the development ports again). Step 4 asserts the version and reads
back the published ports, and `deploy-staging.sh` runs the same guard before every `up`. No minimum Docker
Engine version has been established; only the Engine installed beside Compose v5.1.4 on the author's machine was used. The host also
needs `git`, DNS for the hostnames above, and inbound access to the five published ports. Node and pnpm are
not needed on the host.

**1. Secrets.** Create `infra/.env` from the template, and never over an existing one:

```bash
test -e infra/.env && echo 'infra/.env already exists: edit it, do not overwrite' \
  || { cp -n infra/.env.production.example infra/.env && chmod 600 infra/.env; }
```

Then fill every empty value with the command written above it. Every value in the template is empty on
purpose: compose refuses an empty required variable, so an unfilled one stops the deploy instead of being
used. Do not reuse a laptop's `infra/.env`, and do not copy `COMPOSE_PROFILES` into a server's (it starts the
development mail sink; step 4 fails on it). On a host that already runs the stack the file holds the live
`DB_PASS` and Ory secrets, so only add what is missing, `KRATOS_SMTP_URI` first. `EDGE_IMAGE` comes from
step 3. (`ADMIN_EMAIL` and `ADMIN_PASSWORD` are deliberately not in this file; see step 7.)

**2. Hostnames and sender.** Apply section 4 before anything is built or started: the dashboard's
`NEXT_PUBLIC_*` values are compiled into the web image, and Ory's URLs are read once at start. That includes
`courier.smtp.from_address` in `infra/ory/kratos/kratos.yml`, which ships as `no-reply@open-gateway.local`:
set it to an address on the domain your SMTP provider may send for **before the first deploy**, or every
recovery email goes out from an address the receiving servers will reject or spam-folder.

**3. Edge image.** Take the digest CD published (the `build` job summary lists it), or read it yourself:

```bash
docker buildx imagetools inspect ghcr.io/<owner>/<repo>/edge:<tag> --format '{{.Manifest.Digest}}'
# infra/.env:  EDGE_IMAGE=ghcr.io/<owner>/<repo>/edge@sha256:<64 hex>
```

A tag is refused by `prod-preflight`. `API_IMAGE` and `WEB_IMAGE` are optional: left empty, compose builds
them from this checkout, which bakes in whatever `NEXT_PUBLIC_*` values the compose file holds (step 2).

**4. Render and check, with nothing started.** None of this needs the daemon to run anything:

```bash
bash infra/scripts/check-prod-ports.sh --env-file infra/.env   # Compose >= 2.24, and ONLY the five edge ports published
sh infra/scripts/prod-preflight.check.sh                       # the preflight's own gate cases, against shims
bash infra/scripts/check-prod-ports.check.sh                   # the ports guard's own cases, against a shim
```

`check-prod-ports.sh` renders the production configuration twice, as you will run it and with no `--profile`
flag at all (an explicit `--profile` replaces `COMPOSE_PROFILES` from the env file; a stray bare `up` would
not), and fails if anything but 33000, 33001, 33005, 33010 and 33012 is published. Without `--env-file` it uses
dummy secrets and proves the files alone. Wiring it into CI (`.github/workflows/ci.yml`, no daemon or secrets
needed) is in `.github/workflows/ci.yml` now (the preflight cases run inside `redis:7-alpine`, the image the
preflight really executes in), so an overlay edit that re-publishes a development port fails the build rather
than reaching a host; that workflow has not yet run on a real runner. Mailpit does not exist in production: it
only runs under `--profile dev`.

**5. Preflight.** It runs automatically inside the first `up` and gates `api`, `web` and every gateway node,
so a non-zero exit means nothing else starts. It waits for Kratos to be healthy first, because one check logs
in through Kratos. Every check prints its own line:

```bash
"${C[@]}" up -d --remove-orphans   # first deploy; pulls the edge digest, builds api/web if no image is set
"${C[@]}" logs prod-preflight      # expect "prod preflight passed"
```

When `API_IMAGE` and `WEB_IMAGE` are registry digests, run `"${C[@]}" pull` first, as `deploy-staging.sh`
does, so an image that cannot be fetched fails while the previous stack is still serving. Do not pull when
they are unset: the `:local` fallback names are built, not published.

The checks: `NODE_ENV` is `production` (one YAML anchor feeds preflight, api and web, so this reads the
real value); the gateway secret is not the committed default; `REDIS_PASSWORD` (at least 32 characters),
`DB_PASS` (at least 16) and `PG_EXPORTER_PASSWORD` (at least 32) use only `A-Z a-z 0-9 . _ ~ -` (they are
spliced into URLs and command lines; `openssl rand -hex` output qualifies); Redis refuses an unauthenticated
`PING` **and** accepts the configured password; the Postgres password reaches the pump; `EDGE_IMAGE` is a
digest; `KRATOS_SMTP_URI`; the Kratos session cookie and the dashboard's `COOKIE_SECURE` are `true`; and the
seeded `admin@opengateway.io` / `Admin123!` login is **explicitly rejected** by Kratos.

`KRATOS_SMTP_URI` is parsed the way Go parses it, and refused unless it is `smtp://` or `smtps://` with a
real `host`, `host:port` or `[ipv6]:port`. The host is judged after the last `@` of the authority, which ends at
the first `/`, `?` or `#`; Mailpit, loopback and unspecified hosts are refused, and so is a bare decimal or hex
number. `skip_ssl_verify` and `disable_starttls` may appear only with an explicit false (`0 f F false FALSE
False`), and a `%` anywhere in the query is refused. **An unencoded `/`, `?`, `#` or `@` in the username or
password is rejected** (generated SES and SendGrid secrets often contain them), with a message telling you to
percent-encode it: `/` as `%2F`, `?` as `%3F`, `#` as `%23`, `@` as `%40`, `:` as `%3A`. The URI is never
printed, and the reported host is only ever something that has passed the host:port shape test.

The login probe passes only on an explicit HTTP 400 with a non-zero `wget` exit and the first stderr line
`wget: server returned error: HTTP/1.x 400`; a session token anywhere in the answer fails; a 5xx, a 502 whose
text says "400", a refused connection, a timeout or an empty answer is reported as inconclusive and fails,
because a gate that cannot tell has proved nothing. Each `wget` is bounded with `-T` (10 seconds,
`WGET_TIMEOUT`), so a Kratos that accepts and never answers fails the run instead of hanging `up`. That reading
of busybox `wget` was **measured** on busybox v1.37.0 in `redis:7-alpine`, not assumed. What a 400 cannot prove
is that it was Kratos' "credentials invalid" and not another 400, because `wget` discards the body of an
error response (gap 12).

**Previously deployed host.** Three leftovers from before this change:

- **Mailpit.** It is behind a profile now, so compose still *knows* the service: it is not an orphan, and
  `--remove-orphans` is not expected to remove an old container (reasoned from how compose defines orphans,
  not tested). An old one would keep running with its loopback port 33016. Look for it and remove it:
  `docker ps -a --filter name=open-gateway-mailpit`, then `docker rm -f open-gateway-mailpit`.
- **Health sidecars.** `open-gateway-tyk-healthcheck` and `open-gateway-edge-healthcheck` no longer exist in
  the compose files, so `up -d --remove-orphans` removes them.
- **The old default admin.** See "Previously seeded host" under step 7.

**6. Migrate.** The same order `install.sh` uses: start the stack, then migrate. The `api` container already
carries its own `DATABASE_URL`:

```bash
"${C[@]}" run --rm api npx prisma migrate deploy \
  --schema=/app/packages/database/prisma/schema.prisma
```

**7. Admin bootstrap.** The seed runs inside the api image (`npx prisma db seed`), and an image built before
this change cannot run it: `prisma/seed.ts` imports `../src/index`, which the production stage did not copy,
so it died with `MODULE_NOT_FOUND` before reaching its own checks. `apps/api/Dockerfile` now copies
`packages/database/src/`, and `packages/database/prisma/seed-image-imports.check.ts` fails `pnpm test` if the
seed or the Kratos import ever imports something the production stage does not copy. **Rebuild `api` before
this step** (CD builds it from the commit; a manual `up` builds it when `API_IMAGE` is unset and the local
image is gone, so remove a stale `open-gateway-api:local` first). The seed fails closed: it hands out the published development login
(`admin@opengateway.io` / `Admin123!`) only when `NODE_ENV` is literally `development` or `test` **and** neither
`ADMIN_EMAIL` nor `ADMIN_PASSWORD` is set. In any other case, including `Production`, `staging` or an unset
`NODE_ENV`, it exits non-zero before its first database write unless both are supplied, and a supplied value
is validated, never ignored: the password must be at least 12 characters and at most 72 bytes (bcrypt reads
only the first 72; a multi-byte character counts as several), without leading or trailing whitespace, and
neither value may be the development default. Pass them from your shell rather than on the command line, so they stay out of
history and the process list (bash):

```bash
read -r -p 'Admin email: ' ADMIN_EMAIL
read -r -s -p 'Admin password: ' ADMIN_PASSWORD; echo
export ADMIN_EMAIL ADMIN_PASSWORD
"${C[@]}" run --rm -e ADMIN_EMAIL -e ADMIN_PASSWORD -w /app/packages/database api npx prisma db seed
"${C[@]}" run --rm -e KRATOS_ADMIN_URL=http://kratos:4434 -w /app/packages/database \
  api npx tsx scripts/migrate-users-to-kratos.ts
unset ADMIN_EMAIL ADMIN_PASSWORD
```

Login goes through Kratos, so the seeded Postgres row is not enough: the import creates the Kratos identity
from the seeded bcrypt hash, which is why it uses the same password and needs no second place to set it.
The Kratos admin API is not published in production; the command above reaches it as `kratos:4434` from
inside the network, the same way `install.sh` does.

**Re-seeding.** The seed writes a password only when it *creates* the user. If a user with that email already
exists, its password is **not** changed, but the account is set ACTIVE and made `super_admin` of the default
tenant, and the seed log says so. So re-running with an existing colleague's address promotes them; re-running
with a different address creates a second super_admin. To change an admin password, use Kratos recovery (it
needs working SMTP, step 10).

**Previously seeded host.** A host seeded before this change holds `admin@opengateway.io` with the published
password, as a live super_admin: the seed upserts by email, and nothing here removes an account that already
exists. `prod-preflight` fails while that login works, and this is how to remove it. The Kratos admin API is
only reachable from inside the stack, so use the `api` container (it has Node):

```bash
# 1. Find the identity id.
"${C[@]}" exec -T api node -e "fetch('http://kratos:4434/admin/identities?credentials_identifier=admin@opengateway.io')
  .then(r => r.json()).then(j => console.log(j.map(i => i.id)))"
# 2. Delete it (expect 204).
"${C[@]}" exec -T api node -e "fetch('http://kratos:4434/admin/identities/<id>', {method: 'DELETE'})
  .then(r => console.log(r.status))"
# 3. Deactivate the Postgres user, so the web login also refuses it even if the identity returns.
"${C[@]}" exec -T postgres psql -U opengateway -d opengateway \
  -c "UPDATE users SET status = 'SUSPENDED' WHERE email = 'admin@opengateway.io'"
```

Then create the real administrator as above and re-run the preflight (step 8). The old account's Keto
membership tuple is left in place; a suspended user with no Kratos identity cannot log in, so it grants
nothing. Delete it through the Keto write API (in-network, `keto:4467`) if you want it gone.

**8. Prove the default login is gone.** Re-run the preflight and expect `prod preflight passed`:

```bash
"${C[@]}" run --rm prod-preflight
```

**9. CD (optional).** `.github/workflows/cd-staging.yml` runs `deploy-staging.sh` over SSH when
`vars.STAGING_DEPLOY` is `true`. It needs `secrets.STAGING_SSH_HOST`, `STAGING_SSH_USER`, `STAGING_SSH_KEY`,
`STAGING_KNOWN_HOSTS`, `STAGING_PATH` and `STAGING_HEALTH_URL`, and the build variables
`vars.STAGING_APP_URL`, `STAGING_API_URL`, `STAGING_KRATOS_URL`, `STAGING_HYDRA_URL` and
`STAGING_GATEWAY_URL`, which become the web image's `NEXT_PUBLIC_*` values. The script copies the host's
existing `infra/.env` and rewrites only the three `*_IMAGE` lines, so **`KRATOS_SMTP_URI` must already be in
that file**, or the next deploy stops at interpolation. Before pulling anything it runs
`check-prod-ports.sh` against that env, so a Compose that ignores `!reset`, or a stray `COMPOSE_PROFILES`,
stops the deploy with nothing changed. See [deployment.md](deployment.md#cd--staging-githubworkflowscd-stagingyml).

**10. Smoke checks.** In this order, stopping at the first failure:

```bash
"${C[@]}" ps                                   # long-running services healthy or running; one-shots exited 0
curl -fsS https://<api-host>:33001/api/health  # through the edge, with the certificate you installed
curl -fsS -o /dev/null https://<web-host>:33000/auth/login
```

*Mail delivery.* Nothing so far proves a recovery email can leave the stack, and the preflight deliberately
does not probe the SMTP host. Start a recovery flow for the administrator from inside the network, then
check the mailbox for the code (`<admin-email>` is the address from step 7; the variable is unset by then):

```bash
"${C[@]}" exec -T -e RECOVERY_EMAIL=<admin-email> api node -e '
  const k = "http://kratos:4433";
  (async () => {
    const f = await (await fetch(k + "/self-service/recovery/api", { headers: { Accept: "application/json" } })).json();
    const r = await fetch(k + "/self-service/recovery?flow=" + f.id, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ method: "code", email: process.env.RECOVERY_EMAIL }),
    });
    console.log(r.status, (await r.json()).state);
  })();'
```

`sent_email` only means Kratos queued the message; delivery is the courier's job (`kratos` runs with
`--watch-courier`). If nothing arrives, look at the courier queue (this prints no message bodies, which
hold the recovery code):

```bash
"${C[@]}" exec -T postgres psql -U opengateway -d kratos \
  -c "SELECT id, status, created_at, updated_at FROM courier_messages ORDER BY created_at DESC LIMIT 5"
```

A row that stays queued, with `updated_at` moving, is the courier failing to deliver: read
`"${C[@]}" logs kratos` for the SMTP error. (How `status` is encoded in that table is from Kratos' own
courier code and has not been checked against this deployment.) Then confirm the message's sender and that it
did not land in spam: that is the SPF and DKIM half of section 1.

*Login, end to end.* The post-deploy login check from
[deployment.md](deployment.md#after-redeploying-web-run-the-login-check) does a real Kratos, Hydra, `web`
login as a throwaway user and removes it. It runs **inside the api container**, because production publishes
neither Postgres nor the Kratos admin API. The container already has the database client, the in-network
`DATABASE_URL` and `ORY_KRATOS_ADMIN_URL`; you supply the public URLs the browser flow walks:

```bash
docker cp apps/api/test/e2e/kratos-hydra-login.e2e.mjs open-gateway-api:/tmp/kratos-hydra-login.e2e.mjs
docker exec \
  -e APP_URL=https://<web-host>:33000 -e KRATOS_PUBLIC_URL=https://<kratos-host>:33012 \
  -e HYDRA_PUBLIC_URL=https://<hydra-host>:33010 -e API_URL=https://<api-host>:33001 \
  open-gateway-api node /tmp/kratos-hydra-login.e2e.mjs
# while the edge still signs with its own CA, add:  -e NODE_EXTRA_CA_CERTS=/etc/open-gateway/edge/root.crt
```

Expect `N/N checks passed` and exit 0. Those public hostnames must resolve and be reachable *from the
container* (it dials the host's published ports like any client); that has not been tried on a real
deployment. The throwaway email and password are generated per run, so nothing that outlives the script is an
account with a known password. The script removes its identity and user on SIGINT, SIGTERM and SIGHUP too
(exit 130, 143, 129), Kratos DELETE first, and says how to delete them by hand if that fails; a SIGKILL leaves
the identity, which is why its password is random. Every request it makes is bounded by a 15-second timeout.
It was run through those signals in the built api image against a fake Kratos, not against a real stack. It
leaves its `LOGIN` audit row and prints the id.

*Alerts.* Finally read the alert state, since nothing delivers it (section 5, gap 1). `Watchdog` always
fires by design; anything else needs an explanation:

```bash
"${C[@]}" exec -T prometheus wget -qO- \
  'http://127.0.0.1:9090/api/v1/query?query=ALERTS%7Balertstate%3D%22firing%22%7D'
```

**11. Backup and restore drill.** `postgres-backup` takes a base backup as soon as it starts, then every
`PG_BACKUP_INTERVAL`. Prove one restores, on a scratch instance that never touches the primary's volume:

```bash
bash infra/scripts/pg-restore-scratch.sh --list
bash infra/scripts/pg-restore-scratch.sh          # latest backup: verify, then destroy
```

Exit 0 means "this backup is intact and restorable", not "it equals the primary" (the script's header says
exactly what each layer proves). A production restore is the volume swap in
[deployment.md](deployment.md#disaster-recovery-procedure); there is deliberately no in-place restore script.

**12. Rollback.**

- **Application images.** Put the previous digests back on the `EDGE_IMAGE`, `API_IMAGE` and `WEB_IMAGE`
  lines of `infra/.env` (the CD run summaries list every published digest), then `"${C[@]}" pull` and
  `"${C[@]}" up -d`. Re-running `deploy-staging.sh` with the previous commit and digests does the same.
- **Edge configuration.** Revert `infra/edge/Caddyfile`, then
  `"${C[@]}" exec edge caddy reload --config /etc/caddy/Caddyfile`. The Caddyfile is a bind mount read once
  at start, so the edge image's digest never changes with it ([infra/edge/README.md](../infra/edge/README.md)).
- **Schema.** There are no down migrations: every directory under `packages/database/prisma/migrations`
  holds only `migration.sql`. If a release added a migration, rolling the images back leaves the new schema
  in place, so only roll back across additive migrations; otherwise restore from backup (step 11). The
  checklist line in `deployment.md` that asks for a tested down migration cannot be satisfied as written.

## 4. Every localhost and hostname touchpoint

Counts are of lines containing `localhost`, taken by `grep -c localhost <file>` when this was written. They
move as files change; re-derive with
`grep -rn localhost infra/edge/Caddyfile infra/ory infra/docker-compose.yml apps/web/Dockerfile observability/blackbox.yml`.
None of these values is changed by the compose and bootstrap work, because the domain is not known.

| File | Lines | What is there | What it controls |
|---|---|---|---|
| `infra/edge/Caddyfile` | 10 (5 site lines: `localhost:33000`, `:33001`, `:33005`, `:33010`, `:33012`, each with `{$EDGE_LAN_IP:127.0.0.1}`; the rest comments) | Site addresses; `tls internal` in `edge_site`, the `33005` site and the catch-all; global `default_sni` | The five public listeners, which hostnames they answer for, and where their certificates come from |
| `infra/ory/kratos/kratos.yml` | 11 | `serve.public.base_url` (14); CORS `allowed_origins` (20); `serve.admin.base_url` (27, plain HTTP, internal); `default_browser_return_url` and `allowed_return_urls` (54, 56); the six self-service `ui_url` / `default_browser_return_url` values (64-83). No `session.cookie.domain` is set. `courier.smtp.from_address` is `no-reply@open-gateway.local` (about line 108) | Where Kratos tells the browser to go, which origins may call it with credentials, and the sender of every email |
| `infra/ory/hydra/hydra.yml` | 6 | `urls.self.issuer` (28), `login`, `consent`, `logout`, `error` (30-33), `post_logout_redirect` (34) | The `iss` claim of every token, and where Hydra sends the browser to log in |
| `infra/docker-compose.yml` | 16 (12 values, 4 comments) | `ORY_HYDRA_ISSUER` (891, must equal Hydra's issuer exactly: the API verifies the claim); `CORS_ORIGINS` (897); the web build args `NEXT_PUBLIC_API_URL`, `_KRATOS_URL`, `_HYDRA_URL`, `_APP_URL`, `_GATEWAY_URL` (987-991); the same URLs (four `NEXT_PUBLIC_*` plus `APP_URL`) in the web runtime environment (1004-1015) | Which origin the API trusts, and where the dashboard's browser code sends requests. `APP_URL` is load-bearing for the open-redirect check on `return_to` |
| `apps/web/Dockerfile` | 6 (five `ARG ... =https://localhost:330xx` defaults at 56-59 and 62; one comment) | Build-arg defaults | What a web image built with no arguments contains. CD passes `vars.STAGING_*` (`cd-staging.yml`, 94-99), and its post-deploy check fails when the served bundle does not contain the expected API URL |
| `observability/blackbox.yml` | 7 (four values) | `Host: localhost` and `server_name: localhost` in `oidc_discovery` (76, 78) and `oidc_discovery_insecure` (96, 98) | **Page risk:** once Hydra answers on a real hostname, `OidcDiscoveryOrJwksFailing` (critical) fires permanently until these name that hostname |
| `apps/api/src/modules/observability/metrics.service.ts` | 1 (line 80, `servername: 'localhost'`) | The SNI the API presents when it probes the edge (`EDGE_TLS_PROBE`, `edge:33001`) | **Page risk, and a code change in `apps/api`:** once `localhost` has no certificate, the leaf gauges vanish and `EdgeCertificateMetricsAbsent` fires |
| Hydra's dashboard OAuth client | n/a | Registered by `apps/web` at runtime from `APP_URL` (`apps/web/src/lib/hydra-admin.ts`, 68 and 87-88); it re-registers when the stored redirect URIs differ | Nothing to edit by hand; check it after the first start |
| `apps/api/src/main.ts` (33), `jwt.strategy.ts` (54), `oauth-client.service.ts` (73) | n/a | Code defaults (`http://localhost:33000`, `http://localhost:33010/`) | Only used if the compose variable is missing. Compose sets all three |
| `install.sh` | n/a | Dev flow; writes `localhost` URLs into `apps/*/.env.local` | Not used in production |

Also decide, with the hostnames: `EDGE_LAN_IP` (irrelevant once real certificates exist), `COOKIE_SECURE` (the
overlay defaults the Kratos cookie flag to `true` through `KRATOS_COOKIE_SECURE`, and `prod-preflight` fails on
anything else), and `TRUST_PROXY_HOPS` (`1` while the edge is the only proxy in front of the API; raise it only
to match a real extra hop).

**TCP APIs.** Production publishes no raw-TCP port: the demo mapping `33020:6000` is dev-only, and a TCP API
(`protocol: "tcp"`) bypasses the edge and its WAF entirely. To expose one, give its `listenPort` its own
published port deliberately, in a third compose file passed after the overlay:

```yaml
# infra/docker-compose.tcp.yml  (name is yours; add `-f` for it after the prod overlay)
services:
  tyk-gateway:
    ports:
      - "<host-port>:<listenPort>"
```

That adds a sixth published port, so `infra/scripts/check-prod-ports.sh` will refuse the deploy until its
expected list names it too: that is the point of the guard, and the edit makes the exposure a reviewed
change. The in-network blackbox job `tcp-33020` keeps probing `tyk-gateway:6000` either way and reads `0` until
some API listens there. No alert reads it, so nothing fires.

## 5. Known gaps

Things this change did not fix, or that the repository cannot do for you.

1. **No alert is delivered.** Prometheus evaluates the rules, and nothing sends them anywhere: there is no
   Alertmanager and no `alerting:` block (`observability/prometheus.yml`, `observability/README.md`). The
   only view is the `ALERTS` query in step 10. Pick a receiver before relying on any alert.
2. **CD has never run on a real GitHub runner.** Owner-reported, unverified by this change. It also deploys
   to "staging" only, and now fails at interpolation on a host whose `infra/.env` lacks `KRATOS_SMTP_URI`.
   `ci.yml` now runs the preflight cases (inside `redis:7-alpine`), the ports guard's cases and the ports
   guard itself against the real compose files, and `pnpm test` runs the seed checks; none of that has run on
   a real GitHub runner either, so the first CI run is also the first proof the steps work there.
3. **Certificates.** `tls internal` is a private CA; see section 2. Leaving it also leaves the root-certificate
   alerts without a subject: `EdgeCertificateMetricsAbsent` (role `root`) fires after 10 minutes on a
   deployment with public certificates and no `infra/edge/root.crt`, because the API's gauge for the private
   root is then absent (`observability/rules/open-gateway.yml`).
4. **Cookie scope across hostnames.** See section 2. Untested on a real domain.
5. **Two probes hard-code `localhost`** (section 4, the two "page risk" rows). Changing the domain without
   changing them produces a permanent critical alert and a warning.
6. **Kratos runs with `--dev`** in both compose files (`serve all --dev --watch-courier`). The comment in
   `kratos.yml` says the flag is what lets Kratos accept the edge's plain-HTTP hop. The overlay now forces the
   SESSION cookie to `Secure` (`SESSION_COOKIE_SECURE`, default `true`, checked by the preflight). Kratos'
   separate cookie setting for its continuity and CSRF cookies is not set by anything in this repository and,
   per the go-live re-review, follows `--dev`, so it stays off; that was not checked against Kratos' schema
   here. Whether anything else `--dev` relaxes matters in production has not been assessed. The dashboard's own
   cookies are covered separately: the preflight requires `COOKIE_SECURE=true`.
7. **The WAF only detects.** Coraza runs in `DetectionOnly` (`infra/edge/Caddyfile`): it logs, it does not
   block.
8. **Backups are on the database host.** `pg_backups` and `pg_wal_archive` are Docker volumes beside
   `postgres_data`; losing the machine loses all three. Nothing copies them off.
9. **One edge, one Postgres, one Redis, one host.** The three gateway nodes protect against a node dying, not
   against the host dying (`infra/edge/README.md` documents the edge as a single point of failure).
10. **`docs/deployment.md` contains generic illustrations**, "Production Docker Compose" and "NGINX Reverse
    Proxy Configuration", that are not what this repository deploys. This runbook supersedes them.
11. **A staging host now needs real mail.** `prod-preflight` rejects the Mailpit address and loopback hosts,
    and staging runs the same overlay, so a staging host must be given either a real SMTP account or a
    catch-all mailbox service before the next CD deploy. **Owner decision pending:** no staging-only opt-out
    has been built, on purpose; whether staging should have one is yours to settle.
12. **The preflight cannot prove the SMTP host answers, or that a 400 was "credentials invalid".** It judges
    the URI's host, scheme, port shape and TLS flags, not reachability. `nc` is in the `redis:7-alpine` image,
    so a TCP connect test is possible, but it would turn a provider outage or an egress rule into a failed
    deploy and still would not prove mail is accepted; the mail step in 10 is the only proof of delivery. The
    host test is a list of spellings, not a resolver: octal or mixed IPv4 (`0177.0.0.1`), other IPv6 spellings
    of loopback (`0:0:0:0:0:0:0:1`, `::ffff:7f00:1`), zone ids, and hostnames that merely resolve to loopback
    (`localtest.me`, an `/etc/hosts` alias) are not recognised. Likewise `wget` throws away the body of a 4xx,
    so the default-admin probe cannot tell Kratos' "credentials invalid" from another 400 (a malformed body, a
    flow in a state that rejects the method). Reading the body over `nc` and matching Kratos' message id was
    not done because that id could not be checked without a running Kratos.
13. **Shell compatibility.** `prod-preflight.sh` and its 130-assertion suite (`prod-preflight.check.sh`) were
    run under the real `redis:7-alpine` busybox ash (v1.37.0), both by a reviewer and by the author, and CI
    runs the suite inside that image. The fake `wget` and `redis-cli` in it are shims of busybox behaviour
    measured there, not a real Kratos or Redis. Not tried: Debian's `dash` or any other `sh`.
14. **A fresh `api` image is required for the seed** (step 7). A host running an image from before the
    `COPY packages/database/src/` line cannot seed, and the failure is a module error, not a refusal.

## 6. Open items the owner listed

Reported by the owner and not re-verified by this change.

- `pnpm format:check` is red on more than 420 files.
- Login and logout audit rows are invisible in the product.
- Upstream mTLS fails with upstreams signed by a private CA.
- Development-dependency advisories exist; CI audits production dependencies only.
