# syntax=docker/dockerfile:1

# =============================================================================
# Stage 1: Dependencies
# =============================================================================
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

# Copy workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/web/package.json ./apps/web/
COPY packages/types/package.json ./packages/types/
COPY packages/database/package.json ./packages/database/
COPY packages/ui/package.json ./packages/ui/
COPY packages/config/package.json ./packages/config/

# Install dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts

# =============================================================================
# Stage 2: Builder
# =============================================================================
FROM node:22-alpine AS builder
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages ./packages

# Copy source
COPY . .

# Generate Prisma client
RUN pnpm db:generate

# @open-gateway/database's package.json resolves to ./dist (tsup output), not its TS source, so
# apps/web's `next build` below needs it built first — the same step apps/api/Dockerfile already
# runs, needed here because this app now imports @open-gateway/database directly (oauth2/login's
# Kratos-identity-to-User lookup).
RUN pnpm --filter @open-gateway/database build

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* vars are inlined into the client bundle at BUILD time, not read at container start —
# a value only set on `docker run`/compose `environment:` never reaches client-side code. These must
# come in as build args. Defaults match today's docker-compose.yml so an arg-less build is unchanged.
ARG NEXT_PUBLIC_API_URL=http://localhost:33001/api
ARG NEXT_PUBLIC_KRATOS_URL=http://localhost:33012
ARG NEXT_PUBLIC_HYDRA_URL=http://localhost:33010
ARG NEXT_PUBLIC_APP_URL=http://localhost:33000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_KRATOS_URL=$NEXT_PUBLIC_KRATOS_URL \
    NEXT_PUBLIC_HYDRA_URL=$NEXT_PUBLIC_HYDRA_URL \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

# Build the application
RUN pnpm --filter @open-gateway/web build

# Park the Prisma query engine at a fixed path for the runner stage. `next build --output standalone`
# traces JS imports only, so it bundles @prisma/client's code but leaves the native
# libquery_engine-linux-musl-openssl-3.0.x.so.node behind — every Prisma call in a route handler then
# dies with PrismaClientInitializationError ("could not locate the Query Engine"), which is what
# /oauth2/login (the Kratos-identity-to-User provisioning lookup) hit. The copy is a separate step
# because pnpm's store path embeds a dependency hash (@prisma+client@6.19.3_prisma@...), so only a
# shell glob can name it — Dockerfile COPY cannot.
RUN mkdir -p /prisma-engine && \
    cp /app/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client/*.so.node /prisma-engine/

# =============================================================================
# Stage 3: Runner
# =============================================================================
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone output
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

# Prisma resolves its engine relative to the bundle that loads it; `.next/server/.prisma/client` is
# one of the paths it searches (it names them all in the not-found error). See the builder stage.
COPY --from=builder /prisma-engine/ ./apps/web/.next/server/.prisma/client/

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# `/` 307s an unauthenticated visitor to Hydra's browser-facing URL (localhost:33010), which this
# container can't reach under its own name — that's not a health problem, it's correct redirect
# behavior. /auth/login always renders 200 regardless of auth state, so it's the actual health probe.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/auth/login || exit 1

CMD ["node", "apps/web/server.js"]
