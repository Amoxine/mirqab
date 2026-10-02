# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial monorepo structure with Turborepo
- Next.js 15 App Router frontend
- NestJS 11 backend API
- Prisma 6 with PostgreSQL integration
- Redis-backed refresh-token storage and analytics response caching
- shadcn/ui component library setup
- TanStack Query and Table integration
- React Hook Form with Zod validation
- Docker Compose for local development
- CI/CD pipelines with GitHub Actions
- Comprehensive ESLint and Prettier configuration
- Shared types, config, and UI packages
- Database seeding template
- Health check endpoints
- Production-ready Dockerfiles
- `docs/go-live.md`: the production go-live runbook (owner inputs, steps, every `localhost` touchpoint, known gaps)
- `infra/.env.production.example`: every variable the production overlay and `prod-preflight` require, with the command that generates each
- `infra/scripts/check-prod-ports.sh`: asserts Docker Compose 2.24 or later and that the production configuration publishes only the edge's five ports (rendered with and without `--profile`); `deploy-staging.sh` runs it before `up`
- `infra/scripts/prod-preflight.check.sh` and `infra/scripts/check-prod-ports.check.sh`: shim-based tests of the two gates above, each case mutation-checked
- `prod-preflight` checks for `KRATOS_SMTP_URI` (parsed as Go parses it: a real `smtp(s)://` host:port, not Mailpit, loopback or a bare number, `skip_ssl_verify` / `disable_starttls` only with an explicit false, no `%` in the query, an unencoded `/ ? # @` in the credentials rejected), for `KRATOS_COOKIE_SECURE=true` and `COOKIE_SECURE=true`, and for Redis accepting the configured password; `DB_PASS`, `REDIS_PASSWORD` and `PG_EXPORTER_PASSWORD` are held to `A-Za-z0-9._~-`, and `REDIS_PASSWORD` to 32 characters, `DB_PASS` to 16
- `resolveAdminCredentials` (`packages/database/prisma/admin-credentials.ts`) with `admin-credentials.check.ts`, `seed-refusal.check.ts` and a strict `tsc -p tsconfig.check.json` step, all in `pnpm --filter @open-gateway/database test` (no database involved)
- `kratos-hydra-login.e2e.mjs` runs inside the api container as well as on a dev host. Its cleanup deletes the Kratos identity first, checks the DELETE status, reports the identity id on failure, and runs on SIGINT, SIGTERM and SIGHUP (exit 130, 143, 129); it uses a random email and password per run and bounds every request with a timeout
- `seed-source.check.ts` (the seed takes the admin email and password from `resolveAdminCredentials` and holds no literal default) and `seed-image-imports.check.ts` (everything the seed and the Kratos import load at run time is copied into the api image's production stage), both in the database package tests
- `ci.yml` runs the preflight cases inside `redis:7-alpine`, the ports guard's cases, and the ports guard against the real compose files

### Changed

- The seed fails closed: the development admin (`admin@opengateway.io` / `Admin123!`) is used only when `NODE_ENV` is literally `development` or `test` and neither `ADMIN_EMAIL` nor `ADMIN_PASSWORD` is set; anything else (unset, `Production`, `staging`...) requires both, validated everywhere (password 12 characters to 72 bytes, neither value the development default). A host-side `pnpm db:seed` now needs `NODE_ENV=development`
- The seed logs whether the admin was created or already existed (an existing user keeps its password but is reactivated and made `super_admin`)
- Mailpit is behind the `dev` profile; `install.sh` writes `COMPOSE_PROFILES=dev` into the `infra/.env` it generates and `install.sh` / `rebuild.sh` also pass `--profile dev`, and Kratos' dependency on it is `required: false`. An explicit `--profile` on the command line replaces `COMPOSE_PROFILES`
- The production overlay requires `KRATOS_SMTP_URI`, so a deploy host's `infra/.env` must hold a real SMTP URI before the next CD run
- The production overlay publishes only the edge's five ports: it resets the host ports of Postgres (33002), Redis (33003), Hydra admin (33011), Kratos admin (33013), Keto (33014, 33015) and the raw-TCP demo mapping (33020)
- The production overlay defaults the Kratos session cookie to `Secure`, feeds `NODE_ENV` to `prod-preflight`, `api` and `web` from one anchor, and makes `prod-preflight` wait for Kratos to be healthy
- The production overlay uses the `!reset` YAML tag, which needs a Docker Compose that supports it (2.24 or later)
- `.gitignore` ignores every `.env.<anything>` except the `.example` templates
- `install.sh` labels the printed `Admin123!` login as development-only and points production at `docs/go-live.md`
- `docs/security.md` describes the gateway error mapping as it now is (`Gateway error: ...`, `TykResponseError`)
- The web UI no longer names the gateway or the services behind it (Tyk, Pump, Redis, Hydra, Kratos, Keto, Ory, Postgres, Prisma, Nest, "OAS"): not in any message (en, fr, ar), docs page or page title, not in the API errors it shows (`Gateway error: ...`, and the gateway's own text now has names and internal addresses replaced), and not in node lists (Settings and the dashboard map label a node by position or its configured city, never by host). The "Tyk organization ID" row is gone from Settings (`GET /settings` still returns `tykOrgId`). `apps/web/src/messages/no-tech-terms.test.ts` fails on a regression in messages, docs pages and API prose
- The sign-in pages (`/auth/*`, `/portal/auth/*`) show the logo above the card instead of the brand name; its alt text, in the page's one `<h1>`, is the brand (the portal adds "Developer Portal", ordered per language)
- Page metadata comes from the `nav` messages: translated title and description, `og:locale` per language, no hardcoded "Admin Dashboard" / "Production-ready SaaS admin dashboard" (the `keywords` and `authors` tags are gone)
- The web app refuses to start when `APP_URL` (or `NEXT_PUBLIC_APP_URL`, when `APP_URL` is empty) is set to anything but an absolute `http(s)` URL, with an error naming the variable and the value; empty still means the `localhost` default (`docs/reference/configuration.md`)

### Deprecated

### Removed

- The `tyk-healthcheck` and `edge-healthcheck` curl sidecars: nothing depended on or alerted on them, and blackbox, the API's TLS probe and the Prometheus rules cover the same checks
- The deprecated no-op `--with-tyk` flag of `install.sh`

### Fixed

- `npx prisma db seed` could not run in the built api image (`MODULE_NOT_FOUND` for `../src/index`: the production stage did not copy `packages/database/src/`), so `install.sh`'s seed step and the production admin bootstrap never reached the admin-credentials gate; the Dockerfile now copies it
- The login check's SIGINT/SIGTERM cleanup never ran: the database package's own exit-0 signal handlers, registered on import, won, so the script exited 0 without deleting the throwaway identity (which had a fixed, public password)
- `prod-preflight`'s 400 match accepted a 502 whose text said "400", and its `wget` calls had no timeout, so a Kratos that never answered hung `up`; the SMTP check accepted `skip_ssl_verify=t`, `disable_starttls=T`, percent-encoded keys, `#` before an `@`, and printed a username as the host when the password held an unencoded `/`
- `prod-preflight`'s default-admin check could pass vacuously (it matched `session_token` only as the first JSON key and treated any non-200 answer as success); only an explicit Kratos rejection passes now

### Security

- Production can no longer be seeded with the published development admin password, including through a `NODE_ENV` that merely looks like production
- The production overlay no longer publishes the unauthenticated Kratos admin API (or Postgres) on loopback, and no longer runs a mail sink

## [0.1.0] - 2026-04-07

### Added

- Initial project setup

[Unreleased]: https://github.com/open-gateway/open-gateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/open-gateway/open-gateway/releases/tag/v0.1.0
