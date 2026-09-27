# MIRQAB Web

> Next.js 15 frontend for the MIRQAB SaaS Admin Dashboard

## Overview

The web application is a Next.js 15 (App Router) frontend that provides the admin dashboard UI for managing Tyk API Gateway instances through the NestJS backend API.

**Port:** 33000 (default) (default)
**Framework:** Next.js 15 with App Router
**Rendering:** Server Components + Client Components (TanStack Query)

---

## Page Structure

```
src/app/
├── layout.tsx                    # Root layout: Inter font, metadata, Providers wrapper
├── page.tsx                      # Root page (redirects to /login or /dashboard)
│
├── (auth)/                       # Auth route group — no sidebar layout
│   ├── layout.tsx                # Minimal auth layout (centered card)
│   └── login/
│       └── page.tsx              # Login form (email + password)
│
└── (dashboard)/                  # Dashboard route group — with sidebar + header
    ├── layout.tsx                # Dashboard shell: sidebar navigation, top header
    ├── page.tsx                  # Dashboard home: KPI cards, charts, recent activity
    │
    ├── analytics/                # Analytics & monitoring
    │   └── page.tsx              # Overview metrics, time-series charts, per-API/per-key breakdown
    │
    ├── apis/                     # API definitions management
    │   └── page.tsx              # CRUD table: create, edit, delete, sync to Tyk
    │
    ├── audit-logs/               # Audit trail viewer
    │   └── page.tsx              # Filterable log table: action, resource, user, timestamp
    │
    ├── keys/                     # API key management
    │   └── page.tsx              # CRUD table: create, revoke, view quotas, copy key (once)
    │
    └── tenants/                  # Multi-tenant management
        └── page.tsx              # CRUD table: create, edit, view plan, manage users
```

### Page Details

| Page | Route | Description |
|------|-------|-------------|
| **Login** | `/login` | Email + password form, redirects to dashboard on success |
| **Dashboard Home** | `/` (within dashboard group) | KPI overview: total APIs, keys, tenants, requests, error rate |
| **Analytics** | `/analytics` | Request metrics, latency charts, API/key breakdown, time range selector |
| **APIs** | `/apis` | Data table of API definitions with status, health, sync status, actions |
| **Keys** | `/keys` | Data table of API keys with name, assigned API, status, expiry, actions |
| **Audit Logs** | `/audit-logs` | Paginated log table with filters for action type, resource, date range |
| **Tenants** | `/tenants` | Data table of tenants with name, slug, plan, status, user count |

---

## Component Library

### shadcn/ui Primitives (21 components)

Located in `src/components/ui/`:

| Component | File | Usage |
|-----------|------|-------|
| **Avatar** | `avatar.tsx` | User avatars in header, audit log user column |
| **Badge** | `badge.tsx` | Status indicators (ACTIVE, DRAFT, HEALTHY, etc.) |
| **Button** | `button.tsx` | All interactive buttons (primary, secondary, ghost, destructive) |
| **Card** | `card.tsx` | KPI cards, form containers, section wrappers |
| **Collapsible** | `collapsible.tsx` | Sidebar navigation groups, expandable sections |
| **Command** | `command.tsx` | Command palette, searchable dropdowns |
| **Dialog** | `dialog.tsx` | Modals for create/edit forms, confirmation dialogs |
| **Dropdown Menu** | `dropdown-menu.tsx` | Row action menus, user menu in header |
| **Form** | `form.tsx` | React Hook Form + Zod integration |
| **Input** | `input.tsx` | Text inputs, search fields, form fields |
| **Label** | `label.tsx` | Form field labels |
| **Popover** | `popover.tsx` | Date pickers, tooltip-like overlays |
| **Scroll Area** | `scroll-area.tsx` | Custom scrollable containers |
| **Select** | `select.tsx` | Dropdown selectors (status, tenant, plan) |
| **Separator** | `separator.tsx` | Visual dividers between sections |
| **Skeleton** | `Skeleton.tsx` | Loading placeholders |
| **Sonner** | `sonner.tsx` | Toast notifications (success, error, warning) |
| **Switch** | `switch.tsx` | Toggle controls (enable/disable, active/inactive) |
| **Table** | `table.tsx` | Data tables for APIs, keys, tenants, audit logs |
| **Tabs** | `tabs.tsx` | Tabbed content (analytics views, settings pages) |
| **Tooltip** | `tooltip.tsx` | Hover explanations for icons, actions |

### Layout Components

Located in `src/components/layout/`:

| Component | Purpose |
|-----------|---------|
| **Sidebar** | Navigation menu with links to all dashboard pages |
| **Header** | Top bar with user info, tenant selector, notifications |
| **DashboardLayout** | Wrapper providing sidebar + header shell |

### Providers

Located in `src/components/providers/`:

| Provider | Purpose |
|----------|---------|
| **ThemeProvider** | Dark/light mode toggle |
| **QueryClientProvider** | TanStack Query client setup |
| **ToasterProvider** | Sonner toast notification container |

---

## How to Add a Page

### Step 1: Create the Page Directory and File

```bash
mkdir -p apps/web/src/app/\(dashboard\)/notifications
touch apps/web/src/app/\(dashboard\)/notifications/page.tsx
```

### Step 2: Write the Page Component

```tsx
// apps/web/src/app/(dashboard)/notifications/page.tsx
import { Metadata } from 'next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata: Metadata = {
  title: 'Notifications',
  description: 'View and manage system notifications',
};

export default function NotificationsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
        <p className="text-muted-foreground">
          View and manage system notifications
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Notifications</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No notifications yet.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
```

### Step 3: Add to Sidebar Navigation

Update the sidebar navigation component (typically in `src/components/layout/sidebar.tsx`):

```tsx
import { Bell } from 'lucide-react';

const navItems = [
  // ...existing items
  {
    icon: Bell,
    label: 'Notifications',
    href: '/notifications',
  },
];
```

### Step 4: Create a Data Fetching Hook

```tsx
// apps/web/src/hooks/use-notifications.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export function useNotifications(page = 1, pageSize = 20) {
  return useQuery({
    queryKey: queryKeys.notifications.list({
      page: String(page),
      pageSize: String(pageSize),
    }),
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

Update `src/lib/query-keys.ts`:

```typescript
notifications: {
  all: ['notifications'] as const,
  list: (params: Record<string, string>) =>
    ['notifications', 'list', params] as const,
  detail: (id: string) => ['notifications', 'detail', id] as const,
},
```

---

## Hooks Reference

### `useAuth()`

Returns the current authenticated user.

```tsx
import { useAuth } from '@/hooks/use-auth';

function UserProfile() {
  const { user, isLoading, isAuthenticated } = useAuth();

  if (isLoading) return <Skeleton />;
  if (!isAuthenticated) return <LoginPrompt />;

  return <div>Welcome, {user.name}</div>;
}
```

| Return Value | Type | Description |
|-------------|------|-------------|
| `user` | `User \| null` | Current user object (from `/auth/me`) |
| `isLoading` | `boolean` | Loading state during initial auth check |
| `isAuthenticated` | `boolean` | Whether the user is authenticated |

### `useApis(page, pageSize, status?)`

Fetches paginated API definitions.

```tsx
import { useApis, useCreateApi, useDeleteApi } from '@/hooks/use-apis';

function ApiList() {
  const { data, isLoading } = useApis(1, 20);
  const createApi = useCreateApi();
  const deleteApi = useDeleteApi();

  // ...
}
```

| Hook | Parameters | Returns |
|------|-----------|---------|
| `useApis(page, pageSize, status?)` | Page number, page size, optional status filter | `Query<PaginatedResponse<ApiDefinition>>` |
| `useApi(id)` | API definition ID | `Query<ApiDefinition>` |
| `useCreateApi()` | None | `Mutation<ApiDefinition, Error, CreateApiDto>` |
| `useUpdateApi(id)` | API definition ID | `Mutation<ApiDefinition, Error, UpdateApiDto>` |
| `useDeleteApi()` | None | `Mutation<void, Error, string>` |

### `useKeys(page, pageSize)`

Fetches paginated API keys.

```tsx
import { useKeys, useCreateKey } from '@/hooks/use-keys';

function KeyList() {
  const { data } = useKeys(1, 20);
  const createKey = useCreateKey();

  // ...
}
```

| Hook | Parameters | Returns |
|------|-----------|---------|
| `useKeys(page, pageSize)` | Page number, page size | `Query<PaginatedResponse<ApiKey>>` |
| `useCreateKey()` | None | `Mutation<{ key: string }, Error, CreateKeyDto>` |
| `useRevokeKey()` | None | `Mutation<void, Error, string>` |

### `useAnalyticsOverview(range)`

Fetches analytics overview metrics.

```tsx
import { useAnalyticsOverview, useAnalyticsTimeSeries } from '@/hooks/use-analytics';

function DashboardKpis() {
  const { data } = useAnalyticsOverview('7d');
  const { data: series } = useAnalyticsTimeSeries('requests', '7d');

  // ...
}
```

| Hook | Parameters | Returns |
|------|-----------|---------|
| `useAnalyticsOverview(range)` | Time range (`7d`, `30d`, `90d`) | `Query<AnalyticsOverview>` |
| `useAnalyticsTimeSeries(metric, range)` | Metric name, time range | `Query<TimeSeriesPoint[]>` |
| `useAnalyticsApis(range)` | Time range | `Query<Record<string, number>>` |
| `useAnalyticsKeys(range)` | Time range | `Query<Record<string, number>>` |

---

## State Management

### TanStack Query (Server State)

All server state is managed through **TanStack Query 5**:

- **Queries** fetch data from the API
- **Mutations** create/update/delete data
- **Query invalidation** keeps UI in sync after mutations

```tsx
// Query example
const { data, isLoading, error } = useQuery({
  queryKey: ['apis', 'list', { page: '1', pageSize: '20' }],
  queryFn: () => api.get('/apis?page=1&pageSize=20').then(res => res.data),
  staleTime: 30_000,     // Data is fresh for 30 seconds
  gcTime: 5 * 60_000,   // Keep in garbage collection for 5 minutes
});

// Mutation example
const mutation = useMutation({
  mutationFn: (data) => api.post('/apis', data).then(res => res.data),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['apis'] });
    toast.success('API created successfully');
  },
  onError: (error) => {
    toast.error(error.message || 'Failed to create API');
  },
});
```

### Query Key Factory

Query keys are centralized in `src/lib/query-keys.ts` to prevent duplication and ensure consistent invalidation:

```typescript
export const queryKeys = {
  auth: {
    all: ['auth'] as const,
    me: ['auth', 'me'] as const,
  },
  apis: {
    all: ['apis'] as const,
    list: (params: Record<string, string>) => ['apis', 'list', params] as const,
    detail: (id: string) => ['apis', 'detail', id] as const,
  },
  keys: {
    all: ['keys'] as const,
    list: (params: Record<string, string>) => ['keys', 'list', params] as const,
    detail: (id: string) => ['keys', 'detail', id] as const,
  },
  analytics: {
    all: ['analytics'] as const,
    overview: (range: string) => ['analytics', 'overview', range] as const,
    timeseries: (metric: string, range: string) => ['analytics', 'timeseries', metric, range] as const,
    apis: (range: string) => ['analytics', 'apis', range] as const,
    keys: (range: string) => ['analytics', 'keys', range] as const,
  },
};
```

### No Global Client State

The frontend intentionally avoids global client state management (no Redux, Zustand, Jotai). All state is either:
- **Server state** — managed by TanStack Query
- **Local component state** — `useState`, `useReducer`
- **Form state** — managed by React Hook Form
- **Auth state** — derived from TanStack Query (`useAuth()`)

---

## Styling

### Tailwind CSS 4

Configuration in `tailwind.config.ts` at the workspace level. Key features:

- **CSS variables** for theme tokens (colors, spacing, shadows)
- **Dark mode** via `class` strategy
- **Responsive breakpoints** — `sm`, `md`, `lg`, `xl`, `2xl`
- **Font families** — Inter (primary), monospace (code)

### shadcn/ui Pattern

Components are copied into the project (not installed as a package), allowing full customization:

```tsx
// Example: Customizing a Button
import { Button } from '@/components/ui/button';

<Button variant="destructive" size="sm">
  Delete
</Button>
```

### Utility Function

The `cn()` utility merges Tailwind classes with automatic conflict resolution:

```tsx
// src/lib/utils.ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

Usage:
```tsx
<div className={cn(
  'flex items-center gap-2',
  isActive && 'bg-primary text-primary-foreground',
  className  // allow override from props
)}>
```

---

## API Client

The frontend communicates with the NestJS backend via a configured Axios instance:

```typescript
// src/lib/api-client.ts
import axios from 'axios';

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  withCredentials: true,  // Send cookies with requests
  headers: {
    'Content-Type': 'application/json',
  },
});

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Redirect to login
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);
```

**Key configuration:**
- `withCredentials: true` — sends httpOnly cookies automatically
- `baseURL` from `NEXT_PUBLIC_API_URL` environment variable
- 401 responses trigger redirect to `/login`

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `NEXT_PUBLIC_APP_URL` | No | `http://localhost:33000` | Base URL of the web application |
| `NEXT_PUBLIC_API_URL` | **Yes** | - | Backend API base URL (e.g., `http://localhost:33001/api`) |

**Note:** Only `NEXT_PUBLIC_*` prefixed variables are exposed to the browser. No Tyk credentials are ever present in the frontend.

---

## Running

### Development

```bash
# From project root
pnpm --filter @open-gateway/web dev

# Or from apps/web directory
cd apps/web && pnpm dev
```

Starts Next.js dev server on http://localhost:33000 with hot-reload.

### Production

```bash
# Build
pnpm --filter @open-gateway/web build

# Start
pnpm --filter @open-gateway/web start
```

### Docker

```bash
# Build image
docker build -f apps/web/Dockerfile -t open-gateway-web:latest .

# Run
docker run -p 33000:3000 \
  -e NEXT_PUBLIC_API_URL=http://api:33001/api \
  open-gateway-web:latest
```
