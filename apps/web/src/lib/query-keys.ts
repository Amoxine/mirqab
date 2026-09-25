import { getActiveTenantId } from './active-tenant';

/**
 * Every dashboard key starts with `['tenant', tenantId]` (guidelines §8): cached data of one tenant
 * can never answer a query made for another, and one tenant's cache can be dropped as a unit
 * (`queryKeys.tenantScope(id)`) on a switch. `tenantId` is read at call time, so the prefix follows
 * `X-Tenant-ID` exactly; `null` means "no explicit choice yet — the server's default tenant".
 * The constant-looking members are getters for the same reason.
 *
 * The portal's keys (`hooks/use-portal.ts`) are separate on purpose: a developer's tenant comes from
 * their own session there, never from this header.
 */
const scoped = <T extends readonly unknown[]>(...parts: T) => ['tenant', getActiveTenantId(), ...parts] as const;

export const queryKeys = {
  tenantScope: (tenantId: string | null) => ['tenant', tenantId] as const,
  apis: {
    get all() {
      return scoped('apis');
    },
    lists: () => [...queryKeys.apis.all, 'list'] as const,
    list: (params: Record<string, string>) => [...queryKeys.apis.lists(), params] as const,
    detail: (id: string) => [...queryKeys.apis.all, 'detail', id] as const,
    keys: (id: string, pageSize: number) => [...queryKeys.apis.all, 'detail', id, 'keys', { pageSize }] as const,
    clients: (id: string) => [...queryKeys.apis.all, 'detail', id, 'clients'] as const,
    /** OAS-05: stored spec index + endpoint governance (`GET /apis/:id/endpoints`). */
    endpoints: (id: string) => [...queryKeys.apis.all, 'detail', id, 'endpoints'] as const,
    /** OAS-08: the watched URL's status, detected candidates and a candidate's recomputed diff. */
    specSource: (id: string) => [...queryKeys.apis.all, 'detail', id, 'spec-source'] as const,
    specCandidates: (id: string) => [...queryKeys.apis.all, 'detail', id, 'spec-candidates'] as const,
    candidateDiff: (id: string, candidateId: string) =>
      [...queryKeys.apis.all, 'detail', id, 'spec-candidates', candidateId, 'diff'] as const,
    /** Pending updates of every API of the tenant (`GET /spec-updates`). */
    get specUpdates() {
      return [...queryKeys.apis.all, 'spec-updates'] as const;
    },
  },
  keys: {
    get all() {
      return scoped('keys');
    },
    lists: () => [...queryKeys.keys.all, 'list'] as const,
    list: (params: Record<string, string>) => [...queryKeys.keys.lists(), params] as const,
    detail: (id: string) => [...queryKeys.keys.all, 'detail', id] as const,
    usage: (id: string, range: string) => [...queryKeys.keys.all, 'detail', id, 'usage', range] as const,
  },
  gateway: {
    get status() {
      return scoped('gateway', 'status');
    },
    get nodeHealth() {
      return scoped('gateway', 'nodes', 'health');
    },
  },
  settings: {
    get all() {
      return scoped('settings');
    },
  },
  tenants: {
    get all() {
      return scoped('tenants');
    },
    lists: () => [...queryKeys.tenants.all, 'list'] as const,
    list: (params: Record<string, string>) => [...queryKeys.tenants.lists(), params] as const,
    detail: (id: string) => [...queryKeys.tenants.all, 'detail', id] as const,
    members: (id: string) => [...queryKeys.tenants.all, 'detail', id, 'members'] as const,
    quota: (id: string) => [...queryKeys.tenants.all, 'detail', id, 'quota'] as const,
    usage: (id: string) => [...queryKeys.tenants.all, 'detail', id, 'usage'] as const,
  },
  plans: {
    get all() {
      return scoped('plans');
    },
    detail: (id: string) => [...queryKeys.plans.all, 'detail', id] as const,
  },
  products: {
    get all() {
      return scoped('products');
    },
    detail: (id: string) => [...queryKeys.products.all, 'detail', id] as const,
  },
  roles: {
    get all() {
      return scoped('roles');
    },
    detail: (id: string) => [...queryKeys.roles.all, 'detail', id] as const,
    get permissions() {
      return scoped('roles', 'permissions');
    },
  },
  certificates: {
    get all() {
      return scoped('certificates');
    },
  },
  analytics: {
    get all() {
      return scoped('analytics');
    },
    overview: (range: string) => [...queryKeys.analytics.all, 'overview', range] as const,
    apis: (range: string) => [...queryKeys.analytics.all, 'apis', range] as const,
    keys: (range: string) => [...queryKeys.analytics.all, 'keys', range] as const,
    timeseries: (metric: string, range: string) => [...queryKeys.analytics.all, 'timeseries', metric, range] as const,
    statusCodes: (range: string) => [...queryKeys.analytics.all, 'status-codes', range] as const,
    get health() {
      return scoped('analytics', 'health');
    },
  },
  audit: {
    get all() {
      return scoped('audit-logs');
    },
    lists: (params: Record<string, string>) => [...queryKeys.audit.all, 'list', params] as const,
    stats: (range: string) => [...queryKeys.audit.all, 'stats', range] as const,
    get recent() {
      return scoped('audit-logs', 'recent');
    },
  },
  auth: {
    get me() {
      return scoped('auth', 'me');
    },
  },
};
