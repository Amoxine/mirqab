# ─── Build stage ─────────────────────────────────────────
FROM node:26-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

# Copy workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/api/package.json ./apps/api/
COPY packages/config/package.json ./packages/config/
COPY packages/types/package.json ./packages/types/
COPY packages/database/package.json ./packages/database/

# Install ALL dependencies (needed for Prisma generate)
RUN apk add --no-cache python3 make g++
RUN pnpm install --frozen-lockfile

# Rebuild bcrypt native binding explicitly for Alpine Linux
RUN cd node_modules/.pnpm/bcrypt@5.1.1/node_modules/bcrypt && npm rebuild

# Copy source
COPY apps/api/ ./apps/api/
COPY packages/ ./packages/

# Generate Prisma client
RUN pnpm db:generate

# Build workspace packages that need compilation
RUN pnpm --filter @open-gateway/database build

# Build API
RUN pnpm --filter @open-gateway/api build

# ─── Production stage ────────────────────────────────────
FROM node:26-alpine AS production

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate

# Copy all node_modules from builder (production-ready, includes Prisma engines)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/packages/database/node_modules ./packages/database/node_modules
COPY --from=builder /app/packages/types/node_modules ./packages/types/node_modules
COPY --from=builder /app/packages/config/node_modules ./packages/config/node_modules

# Copy workspace definition files
COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/database/package.json ./packages/database/
COPY packages/types/package.json ./packages/types/
COPY packages/config/package.json ./packages/config/

# Copy Prisma schema (already generated in node_modules)
COPY packages/database/prisma/ ./packages/database/prisma/

# One-off maintenance scripts run through `docker compose run api` — install.sh calls
# migrate-users-to-kratos.ts here right after seeding, so the seeded admin actually has a Kratos
# identity to log in with. Without this the script isn't in the image at all.
COPY packages/database/scripts/ ./packages/database/scripts/

# Copy workspace packages (compiled database, source types)
COPY --from=builder /app/packages/database/dist ./packages/database/dist
COPY packages/types/src ./packages/types/src

# Copy built application
COPY --from=builder /app/apps/api/dist ./apps/api/dist

# Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

USER appuser

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/api/health || exit 1

# Production Node.js flags
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=512"

WORKDIR /app/apps/api
CMD ["node", "dist/main.js"]
