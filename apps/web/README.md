# MIRQAB Web

Next.js 15 (App Router) dashboard and developer portal for MIRQAB. Client-rendered with TanStack Query; the only server-side code is the `oauth2/*` and `locale` route handlers and `middleware.ts`. Talks to the NestJS API (`apps/api`) directly from the browser.

> **Full reference: [docs/reference/web-app.md](../../docs/reference/web-app.md)** — routes, every component folder, hooks, the Kratos/Hydra session flow, i18n/RTL, theming, environment variables, testing. This README only covers running it.

## Run

```bash
pnpm --filter @open-gateway/web dev        # next dev --turbopack on http://localhost:3000
pnpm --filter @open-gateway/web build
pnpm --filter @open-gateway/web start      # port 3000
```

In the Docker stack the app is reached through the Caddy edge at `https://localhost:33000`; port 3000 is the container-internal port.

| Script | Purpose |
|---|---|
| `dev` / `build` / `start` | Next.js dev server (Turbopack), production build, production server |
| `lint` | `next lint --max-warnings 0` |
| `typecheck` | `tsc --noEmit` |
| `test` / `test:watch` | Vitest |
| `check:contrast` | WCAG contrast check of the design tokens (`scripts/check-contrast.js`) |

## Layout

```
src/
  app/            routes: (dashboard), (auth), portal, oauth2 handlers, locale
  components/     feature folders (analytics, apis, dashboard, keys, layout, portal …) + ui/ (re-exports @open-gateway/ui)
  hooks/          TanStack Query hooks and small utilities (use-analytics, use-traffic-filters …)
  lib/            api-client, refresh-retry, oauth-cookies, gateway-locations …
  i18n/, messages/  next-intl setup and en / fr / ar message files
  styles/globals.css  design tokens; imports packages/ui styles
```

## Configuration

`NEXT_PUBLIC_*` variables are **inlined at build time** — set them as Docker build args (see `apps/web/Dockerfile` and `infra/docker-compose.yml`), not only as runtime env. The full list, including `NEXT_PUBLIC_API_URL`, the Ory URLs and `NEXT_PUBLIC_GATEWAY_NODE_LOCATIONS` (places gateway nodes on the dashboard map), is in [docs/reference/configuration.md](../../docs/reference/configuration.md).

## Conventions

- shadcn components only; shared ones live in `packages/ui` ([docs/reference/packages.md](../../docs/reference/packages.md)).
- Forms: React Hook Form + Zod. Create/edit forms use `Sheet`.
- No hard-coded strings: every text goes through `next-intl`, in all three locales.
- Every page has loading, empty and error states and is gated with `PermissionGate` / `PagePermissionGate`.
- Session cookies are `mq_access_token` / `mq_refresh_token` (`src/lib/cookie-names.ts`).
