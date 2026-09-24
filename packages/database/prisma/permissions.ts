/**
 * The permission catalogue (R13's tripwire). Split out of `seed.ts` so it can be imported by
 * `permissions.check.ts` without running the seed script's `main()` (which connects to Postgres as
 * a side effect of module load — `seed.ts` has no `require.main === module` guard, so anything that
 * merely IMPORTS it also seeds the database).
 *
 * Any new permission must be added here consciously — that is the whole point of R13's tripwire
 * (`permissions.check.ts`): count/contents drift is a signal to go find out why, not something to
 * wave through by updating the expected list without reading this comment.
 */
export const PERMISSIONS = [
  // API management
  { name: 'api:read', resource: 'api', action: 'read' },
  { name: 'api:create', resource: 'api', action: 'create' },
  { name: 'api:update', resource: 'api', action: 'update' },
  { name: 'api:delete', resource: 'api', action: 'delete' },
  { name: 'api:sync', resource: 'api', action: 'sync' },
  // API keys
  { name: 'key:read', resource: 'key', action: 'read' },
  { name: 'key:create', resource: 'key', action: 'create' },
  { name: 'key:update', resource: 'key', action: 'update' },
  { name: 'key:revoke', resource: 'key', action: 'revoke' },
  // Tenants
  { name: 'tenant:read', resource: 'tenant', action: 'read' },
  { name: 'tenant:create', resource: 'tenant', action: 'create' },
  { name: 'tenant:update', resource: 'tenant', action: 'update' },
  { name: 'tenant:delete', resource: 'tenant', action: 'delete' },
  // Users
  { name: 'user:read', resource: 'user', action: 'read' },
  { name: 'user:create', resource: 'user', action: 'create' },
  { name: 'user:update', resource: 'user', action: 'update' },
  { name: 'user:delete', resource: 'user', action: 'delete' },
  // Roles
  { name: 'role:read', resource: 'role', action: 'read' },
  { name: 'role:create', resource: 'role', action: 'create' },
  { name: 'role:update', resource: 'role', action: 'update' },
  { name: 'role:delete', resource: 'role', action: 'delete' },
  // Analytics
  { name: 'analytics:read', resource: 'analytics', action: 'read' },
  { name: 'analytics:export', resource: 'analytics', action: 'export' },
  // Audit logs
  { name: 'audit:read', resource: 'audit', action: 'read' },
  { name: 'audit:export', resource: 'audit', action: 'export' },
  // Settings
  { name: 'settings:read', resource: 'settings', action: 'read' },
  { name: 'settings:update', resource: 'settings', action: 'update' },
  // Plans (WP18) — commercial rate/quota tiers, each backed by one Tyk policy
  { name: 'plan:read', resource: 'plan', action: 'read' },
  { name: 'plan:create', resource: 'plan', action: 'create' },
  { name: 'plan:update', resource: 'plan', action: 'update' },
  { name: 'plan:delete', resource: 'plan', action: 'delete' },
  // Products (WP18) — bundles of APIs published together
  { name: 'product:read', resource: 'product', action: 'read' },
  { name: 'product:create', resource: 'product', action: 'create' },
  { name: 'product:update', resource: 'product', action: 'update' },
  { name: 'product:delete', resource: 'product', action: 'delete' },
  // Certificates (WP26a) — no cert:update: a cert is uploaded or deleted, never edited in place
  // (matches Tyk's own /tyk/certs, which has no PUT).
  { name: 'cert:read', resource: 'cert', action: 'read' },
  { name: 'cert:create', resource: 'cert', action: 'create' },
  { name: 'cert:delete', resource: 'cert', action: 'delete' },
] as const;
