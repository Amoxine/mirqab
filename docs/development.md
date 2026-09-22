# Development Guide

> Complete developer guide for contributing to Open Gateway — SaaS Admin Dashboard for Tyk OSS

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start](#quick-start)
3. [Starting Individual Services](#starting-individual-services)
4. [Code Structure](#code-structure)
5. [How to Add a New NestJS Module](#how-to-add-a-new-nestjs-module)
6. [How to Add a New Next.js Page](#how-to-add-a-new-nextjs-page)
7. [Database Workflow](#database-workflow)
8. [Code Style](#code-style)
9. [Git Workflow](#git-workflow)
10. [Testing](#testing)
11. [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Tool | Minimum Version | How to Check |
|------|----------------|--------------|
| **Node.js** | 20.0.0 | `node --version` |
| **pnpm** | 9.0.0 | `pnpm --version` |
| **Docker** | 24.0+ | `docker --version` |
| **Docker Compose** | v2 | `docker compose version` |
| **Git** | 2.30+ | `git --version` |

### Installing pnpm

If you don't have pnpm installed:

```bash
# Using corepack (recommended, ships with Node.js 16.13+)
corepack enable
corepack prepare pnpm@10.4.1 --activate

# Or via npm
npm install -g pnpm@10.4.1
```

### Installing Docker

- **macOS/Windows:** [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- **Linux:** [Docker Engine](https://docs.docker.com/engine/install/) + [Compose plugin](https://docs.docker.com/compose/install/)

---

## Quick Start

### One-Command Setup

The fastest way to get a fully working development environment:

```bash
bash infra/scripts/setup.sh
```

This script performs all steps below automatically:

1. Checks Node.js and pnpm versions
2. Runs `pnpm install` to install all workspace dependencies
3. Copies `.env.example` to `.env.local` for both `apps/web` and `apps/api`
4. Starts PostgreSQL and Redis via `docker compose`
5. Waits for both services to be healthy
6. Generates the Prisma client (`pnpm db:generate`)
7. Runs database migrations (`pnpm db:migrate:dev`)
8. Seeds the database with default data (`pnpm db:seed`)

After setup completes, access:
- **Web App:** http://localhost:33000
- **API Server:** http://localhost:33001/api
- **Prisma Studio:** http://localhost:33004

### Manual Setup

If you prefer to run each step yourself:

```bash
# 1. Install all workspace dependencies
pnpm install

# 2. Create environment files
cp apps/web/.env.example apps/web/.env.local
cp apps/api/.env.example apps/api/.env.local

# 3. Start infrastructure (PostgreSQL 16 + Redis 7)
pnpm infra:up

# Wait for health checks...
pnpm infra:logs  # Verify services are healthy

# 4. Generate Prisma client
pnpm db:generate

# 5. Run database migrations (creates tables, indexes, enums)
pnpm db:migrate:dev

# 6. Seed database with default admin user, roles, and permissions
pnpm db:seed
```

---

## Starting Individual Services

```bash
# Start ALL services in parallel (watch mode via Turborepo)
pnpm dev

# Start ONLY Next.js frontend (http://localhost:33000)
pnpm --filter @open-gateway/web dev

# Start ONLY NestJS backend (http://localhost:33001)
pnpm --filter @open-gateway/api dev

# Open Prisma Studio for database browsing (http://localhost:33004)
pnpm db:studio

# Start only infrastructure (without apps)
pnpm infra:up

# Tail Docker logs
pnpm infra:logs

# Stop all Docker services
pnpm infra:down
```

### Turborepo Affected Builds

Turborepo automatically detects which packages are affected by your changes and only rebuilds what's necessary:

```bash
# Only lint changed files
pnpm lint

# Only build changed packages
pnpm build
```

---

## Code Structure

### Backend (`apps/api`)

```
apps/api/src/
├── main.ts                    # Bootstrap: NestFactory, pipes, filters, CORS
├── app.module.ts              # Root module: imports all 8 feature modules
├── app.controller.ts          # GET /, GET /health
├── app.service.ts             # Health check logic
│
├── modules/                   # 8 feature modules (bounded contexts)
│   ├── auth/                  # JWT authentication, login, register, refresh
│   ├── tenants/               # Tenant CRUD, user-tenant mapping
│   ├── api-management/        # API definition CRUD + Tyk sync
│   ├── tyk-integration/       # Tyk Admin API client (circuit breaker protected)
│   ├── keys/                  # API key lifecycle (create, revoke, expire)
│   ├── quotas/                # Per-key usage limits and resets
│   ├── analytics/             # Usage metrics, time-series, dashboards
│   └── audit/                 # Append-only audit log
│
└── common/                    # Shared infrastructure
    ├── circuit-breaker/       # Breaker service, wired into TykClientService.request()
    ├── decorators/            # Custom decorators (e.g., @CurrentTenant())
    ├── filters/               # AllExceptionsFilter (unified error format)
    ├── guards/                # JwtAuthGuard, TenantGuard, RolesGuard
    ├── interceptors/          # AuditInterceptor, LoggingInterceptor
    ├── middleware/            # CorrelationIdMiddleware
    ├── redis/                 # Redis client module
    ├── types/                 # Shared TypeScript types
    └── common.module.ts       # Common module registration
```

Each feature module follows **clean architecture / hexagonal architecture**:

```
modules/auth/
├── auth.module.ts              # Module registration, imports, exports
├── controllers/
│   └── auth.controller.ts      # HTTP endpoints (@Post, @Get)
├── services/
│   └── auth.service.ts         # Business logic
├── strategies/
│   └── jwt.strategy.ts         # Passport JWT strategy
├── dto/
│   ├── login.dto.ts            # Request validation (class-validator)
│   └── register.dto.ts
└── types/
    └── auth.types.ts           # Internal types, JWT payload
```

### Frontend (`apps/web`)

```
apps/web/src/
├── app/                        # Next.js 15 App Router
│   ├── layout.tsx              # Root layout (fonts, metadata, Providers)
│   ├── page.tsx                # Root page (redirects to /login or dashboard)
│   ├── (auth)/                 # Auth route group (no sidebar layout)
│   │   ├── layout.tsx
│   │   └── login/
│   │       └── page.tsx        # Login form
│   └── (dashboard)/            # Dashboard route group (with sidebar layout)
│       ├── layout.tsx          # Dashboard shell (sidebar, header)
│       ├── page.tsx            # Dashboard home (KPIs, charts)
│       ├── analytics/          # Analytics page
│       ├── apis/               # API definitions management
│       ├── audit-logs/         # Audit log viewer
│       ├── keys/               # API key management
│       └── tenants/            # Tenant management
│
├── components/
│   ├── ui/                     # 21 shadcn/ui primitive components
│   │   ├── avatar.tsx
│   │   ├── badge.tsx
│   │   ├── button.tsx
│   │   ├── card.tsx
│   │   ├── collapsible.tsx
│   │   ├── command.tsx
│   │   ├── dialog.tsx
│   │   ├── dropdown-menu.tsx
│   │   ├── form.tsx
│   │   ├── input.tsx
│   │   ├── label.tsx
│   │   ├── popover.tsx
│   │   ├── scroll-area.tsx
│   │   ├── select.tsx
│   │   ├── separator.tsx
│   │   ├── skeleton.tsx
│   │   ├── sonner.tsx          # Toast notifications
│   │   ├── switch.tsx
│   │   ├── table.tsx
│   │   ├── tabs.tsx
│   │   └── tooltip.tsx
│   ├── layout/                 # Layout-specific components (sidebar, header)
│   ├── providers/              # React context providers
│   └── providers.tsx           # Re-export
│
├── hooks/                      # 4 custom React hooks
│   ├── use-analytics.ts        # Analytics data fetching + mutations
│   ├── use-apis.ts             # API definition CRUD hooks
│   ├── use-auth.ts             # Current user auth state
│   └── use-keys.ts             # API key CRUD hooks
│
├── lib/
│   ├── api-client.ts           # Axios instance (base URL, interceptors, cookies)
│   ├── query-keys.ts           # TanStack Query key factory
│   └── utils.ts                # cn() utility (clsx + tailwind-merge)
│
├── styles/
│   └── globals.css             # Tailwind directives, CSS variables
│
└── types/
    ├── index.ts                # Re-exported types
    └── local.ts                # Frontend-specific types
```

### Shared Packages

| Package | Path | Purpose |
|---------|------|---------|
| `@open-gateway/config` | `packages/config/` | Shared ESLint, Prettier, Tailwind, TypeScript configs |
| `@open-gateway/database` | `packages/database/` | Prisma schema, migrations, seed, PrismaClient export |
| `@open-gateway/types` | `packages/types/` | Shared TypeScript types and DTOs |
| `@open-gateway/ui` | `packages/ui/` | Base shadcn/ui component library |

---

## How to Add a New NestJS Module

Follow this step-by-step guide to add a new feature module (e.g., `notifications`).

### Step 1: Generate Module, Controller, and Service

```bash
cd apps/api
nest generate module modules/notifications
nest generate controller modules/notifications
nest generate service modules/notifications
```

This creates:
```
src/modules/notifications/
├── notifications.module.ts
├── notifications.controller.ts
├── notifications.service.ts
└── notifications.controller.spec.ts
```

### Step 2: Create DTOs

Create `src/modules/notifications/dto/` for request validation:

```typescript
// src/modules/notifications/dto/create-notification.dto.ts
import { IsString, IsOptional, IsEnum } from 'class-validator';

export enum NotificationPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export class CreateNotificationDto {
  @IsString()
  title: string;

  @IsString()
  message: string;

  @IsEnum(NotificationPriority)
  priority: NotificationPriority;

  @IsOptional()
  @IsString()
  recipientId?: string;
}
```

### Step 3: Implement the Service

```typescript
// src/modules/notifications/notifications.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateNotificationDto } from './dto/create-notification.dto';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateNotificationDto, tenantId: string) {
    return this.prisma.notification.create({
      data: { ...dto, tenantId },
    });
  }

  async findAll(tenantId: string, page = 1, pageSize = 20) {
    const skip = (page - 1) * pageSize;
    const [data, total] = await Promise.all([
      this.prisma.notification.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.notification.count({ where: { tenantId } }),
    ]);
    return { data, total, page, pageSize };
  }

  async findOne(id: string, tenantId: string) {
    return this.prisma.notification.findFirstOrThrow({
      where: { id, tenantId },
    });
  }

  async markAsRead(id: string, tenantId: string) {
    return this.prisma.notification.update({
      where: { id, tenantId },
      data: { readAt: new Date() },
    });
  }

  async remove(id: string, tenantId: string) {
    return this.prisma.notification.delete({
      where: { id, tenantId },
    });
  }
}
```

### Step 4: Implement the Controller

```typescript
// src/modules/notifications/notifications.controller.ts
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';

@Controller('notifications')
@UseGuards(JwtAuthGuard, TenantGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Post()
  create(@Body() dto: CreateNotificationDto) {
    return this.service.create(dto, 'tenant-id-from-guard');
  }

  @Get()
  findAll(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.service.findAll('tenant-id-from-guard', +page, +pageSize);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id, 'tenant-id-from-guard');
  }

  @Patch(':id/read')
  markAsRead(@Param('id') id: string) {
    return this.service.markAsRead(id, 'tenant-id-from-guard');
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id, 'tenant-id-from-guard');
  }
}
```

### Step 5: Register in Module

```typescript
// src/modules/notifications/notifications.module.ts
import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
```

### Step 6: Import in AppModule

```typescript
// src/app.module.ts — add to imports array
import { NotificationsModule } from './modules/notifications/notifications.module';

@Module({
  imports: [
    // ... existing imports
    NotificationsModule,
  ],
})
```

### Step 7: Add Database Model (if needed)

Add the model to `packages/database/prisma/schema.prisma`:

```prisma
model Notification {
  id          String   @id @default(uuid())
  tenantId    String   @map("tenant_id")
  title       String
  message     String
  priority    String   @default("MEDIUM")
  readAt      DateTime? @map("read_at")
  createdAt   DateTime @default(now()) @map("created_at")

  @@index([tenantId, createdAt(sort: Desc)])
  @@map("notifications")
}
```

Then generate and run the migration:

```bash
pnpm db:migrate:dev --name add_notifications
pnpm db:generate
```

---

## How to Add a New Next.js Page

Follow this step-by-step guide to add a new page (e.g., `/notifications`).

### Step 1: Create the Page Directory and File

```bash
mkdir -p apps/web/src/app/\(dashboard\)/notifications
touch apps/web/src/app/\(dashboard\)/notifications/page.tsx
```

### Step 2: Create the Page Component

```tsx
// apps/web/src/app/(dashboard)/notifications/page.tsx
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Notifications',
  description: 'Manage system notifications',
};

export default function NotificationsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        <p className="text-muted-foreground">
          View and manage notification center
        </p>
      </div>

      {/* Your page content here */}
    </div>
  );
}
```

### Step 3: Add to Sidebar Navigation

Update the sidebar component (likely in `apps/web/src/components/layout/sidebar.tsx`) to include the new page:

```tsx
// Add to the navigation items array
{
  icon: <BellIcon className="h-4 w-4" />,
  label: 'Notifications',
  href: '/notifications',
}
```

### Step 4: Create a Hook for Data Fetching (optional)

```tsx
// apps/web/src/hooks/use-notifications.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export function useNotifications(page = 1, pageSize = 20) {
  return useQuery({
    queryKey: queryKeys.notifications.list({ page: String(page), pageSize: String(pageSize) }),
    queryFn: () =>
      api
        .get(`/notifications?page=${page}&pageSize=${pageSize}`)
        .then((res) => res.data),
  });
}

export function useMarkAsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.patch(`/notifications/${id}/read`).then((res) => res.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.notifications.all }),
  });
}
```

### Step 5: Add Query Keys

Add to `apps/web/src/lib/query-keys.ts`:

```typescript
notifications: {
  all: ['notifications'] as const,
  list: (params: Record<string, string>) =>
    ['notifications', 'list', params] as const,
  detail: (id: string) => ['notifications', 'detail', id] as const,
},
```

---

## Database Workflow

### Prisma Commands Reference

| Command | Description |
|---------|-------------|
| `pnpm db:generate` | Generate PrismaClient TypeScript types from schema |
| `pnpm db:migrate:dev` | Create + apply a new migration (prompts for name) |
| `pnpm db:migrate` | Apply pending migrations (production mode, no prompt) |
| `pnpm db:seed` | Run seed script (`packages/database/prisma/seed.ts`) |
| `pnpm db:studio` | Open Prisma Studio (visual database browser) |
| `pnpm db:reset` | Drop and recreate database (dev only!) |

### Creating a New Migration

```bash
# Generate a migration with a descriptive name
pnpm db:migrate:dev --name add_user_avatar_field

# This creates:
# packages/database/prisma/migrations/
#   YYYYMMDDHHMMSS_add_user_avatar_field/
#     └── migration.sql
```

### Using Prisma Studio

```bash
pnpm db:studio
```

Opens http://localhost:33004 — browse all tables, edit records, and test queries visually.

### Seeding

The seed script (`packages/database/prisma/seed.ts`) is **idempotent** — safe to run multiple times. It creates:

- Default admin user
- Default roles (admin, operator, viewer)
- Default permissions
- Demo tenant

Run it manually:

```bash
pnpm db:seed
```

### Schema Changes Workflow

1. Edit `packages/database/prisma/schema.prisma`
2. Run `pnpm db:migrate:dev --name describe_change`
3. Run `pnpm db:generate` (regenerates PrismaClient types)
4. Update backend services to use new fields
5. Commit the migration file + schema change

---

## Code Style

### TypeScript

- **Strict mode enabled** — `strict: true`, `noImplicitAny: true`, `strictNullChecks: true`
- **No `any`** — use proper types, `unknown` + type guards, or Zod schemas
- **Explicit return types** on public functions and methods
- **Interfaces for object shapes** — use `type` for unions, intersections, mapped types

### ESLint (Flat Config — ESLint 9)

Configuration is in `eslint.config.js` at the root. Key rules:

- TypeScript type-aware linting enabled
- React hooks rules enforced
- Security rules active (no `eval`, no `imul`, no prototype pollution)
- Per-package overrides via `files` patterns

```bash
# Lint all packages
pnpm lint

# Auto-fix lint errors
pnpm lint:fix
```

### Prettier

Formatting is fully automated. Configuration in `.prettierrc`:

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "all",
  "printWidth": 100
}
```

```bash
# Format all files
pnpm format

# Check without modifying
pnpm format:check
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

[optional body]
[optional footer]
```

| Type | When to Use |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation changes |
| `style` | Code formatting (no logic change) |
| `refactor` | Code restructuring (no behavior change) |
| `test` | Adding or updating tests |
| `chore` | Maintenance, dependencies, tooling |

Examples:
```
feat(api-management): add sync status polling
fix(auth): handle expired refresh tokens gracefully
docs: add deployment guide
chore(deps): update prisma to 6.2.0
```

---

## Git Workflow

### Branch Strategy

```
main (production-ready)
  ├── feature/your-feature
  ├── fix/bug-description
  ├── refactor/module-restructure
  └── docs/documentation-update
```

### Workflow

1. **Create a feature branch** from `main`:
   ```bash
   git checkout main
   git pull origin main
   git checkout -b feature/notifications-module
   ```

2. **Develop** — make commits with conventional messages:
   ```bash
   git add .
   git commit -m "feat(notifications): add notifications module, controller, service"
   ```

3. **Validate locally** before pushing:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test
   ```

4. **Push and open a PR**:
   ```bash
   git push -u origin feature/notifications-module
   ```

5. **PR Requirements:**
   - Descriptive title and body
   - All CI checks passing (lint, typecheck, test, build)
   - At least 1 code review approval
   - No merge conflicts with `main`

### CI Pipeline

The CI workflow (`.github/workflows/ci.yml`) runs on every push and PR:

```yaml
Steps:
  1. Checkout code
  2. Setup pnpm + cache
  3. pnpm install
  4. pnpm db:generate
  5. pnpm lint          (ESLint)
  6. pnpm typecheck     (TypeScript)
  7. pnpm test          (unit + integration tests)
  8. pnpm build         (Next.js + NestJS)
```

---

## Testing

### Running Tests

```bash
# All packages
pnpm test

# Watch mode (reruns on file changes)
pnpm test:watch

# With coverage
pnpm test -- --coverage
```

### Backend Testing (NestJS + Jest)

```typescript
// apps/api/src/modules/notifications/notifications.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('NotificationsService', () => {
  let service: NotificationsService;

  const mockPrisma = {
    notification: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirstOrThrow: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create a notification', async () => {
    const dto = { title: 'Test', message: 'Hello', priority: 'HIGH' };
    mockPrisma.notification.create.mockResolvedValue({ id: '1', ...dto });

    const result = await service.create(dto, 'tenant-1');

    expect(mockPrisma.notification.create).toHaveBeenCalledWith({
      data: { ...dto, tenantId: 'tenant-1' },
    });
    expect(result.id).toBe('1');
  });
});
```

### Frontend Testing

- **Unit tests:** Jest + React Testing Library for components
- **E2E tests:** Playwright (`apps/web/e2e/`)

---

## Troubleshooting

### Port Already in Use

```bash
# Find and kill process on specific ports
lsof -ti:33000 | xargs kill -9  # Web
lsof -ti:33001 | xargs kill -9  # API
lsof -ti:33002 | xargs kill -9  # PostgreSQL
lsof -ti:33003 | xargs kill -9  # Redis
```

### Docker Services Won't Start

```bash
# Check container status
docker compose -f infra/docker-compose.yml ps

# View logs
docker compose -f infra/docker-compose.yml logs postgres
docker compose -f infra/docker-compose.yml logs redis

# Force recreate
docker compose -f infra/docker-compose.yml down -v
docker compose -f infra/docker-compose.yml up -d
```

### Database Connection Failed

```bash
# 1. Verify PostgreSQL is running
docker compose -f infra/docker-compose.yml ps postgres

# 2. Test connection manually
docker compose -f infra/docker-compose.yml exec postgres \
  psql -U opengateway -d opengateway -c "SELECT 1;"

# 3. Reset database (WARNING: loses all data)
pnpm db:reset
pnpm db:generate
pnpm db:migrate:dev
pnpm db:seed
```

### Prisma Client Not Generated

```bash
pnpm db:generate
```

### TypeScript Errors About Prisma Types

```bash
# Regenerate PrismaClient types
pnpm db:generate

# Then restart your TypeScript server (in IDE)
```

### Turborepo Cache Issues

```bash
# Clear turbo cache and restart
rm -rf .turbo
pnpm dev
```

### ESLint Errors After Config Changes

```bash
# Clear ESLint cache
rm -rf node_modules/.cache
pnpm lint:fix
```

### "Module Not Found" Errors

```bash
# Reinstall all dependencies (pnpm workspace)
pnpm install --force
```

### Migration Conflicts

```bash
# If migrations conflict between branches:
# 1. Reset the database
pnpm db:reset

# 2. Regenerate and apply your branch's migrations
pnpm db:generate
pnpm db:migrate:dev

# 3. Re-seed
pnpm db:seed
```

### CORS Errors from Frontend

Ensure `CORS_ORIGINS` in `apps/api/.env.local` includes your frontend URL:

```env
CORS_ORIGINS=http://localhost:33000
```

### JWT Auth Errors

1. Ensure `JWT_SECRET` is set in `apps/api/.env.local`
2. Check that the API cookie domain/path matches your frontend
3. Verify `NEXT_PUBLIC_API_URL` points to the correct API endpoint

---

## Getting Help

- **Documentation:** Check the [docs/](../docs/) directory
- **Issues:** Open a [GitHub Issue](https://github.com/open-gateway/open-gateway/issues)
- **Architecture:** See [docs/architecture.md](architecture.md); [SISYPHUS_PLAN.md](../SISYPHUS_PLAN.md) is the original generation plan, kept as a historical record only
