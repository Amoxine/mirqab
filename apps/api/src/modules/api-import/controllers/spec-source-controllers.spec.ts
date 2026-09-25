import 'reflect-metadata';
import { AUDIT_KEY } from '../../../common/decorators/audit.decorator';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { SpecSourceController, SpecUpdatesController } from './spec-source.controller';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

/**
 * OAS-08 routes and the permission / audit decision each must carry (static evidence). A new handler
 * not listed here fails the first test. Existing permissions only: `api:read` to look, `api:update`
 * to change what is watched or applied.
 */
const SOURCE_ROUTES: Record<string, { permissions: string[]; audit: string | null }> = {
  getSource: { permissions: ['api:read'], audit: null },
  putSource: { permissions: ['api:update'], audit: 'api:updated' },
  removeSource: { permissions: ['api:update'], audit: 'api:updated' },
  // Changes no configuration; a detected change writes its own SPEC_UPDATE_DETECTED row.
  check: { permissions: ['api:update'], audit: null },
  listCandidates: { permissions: ['api:read'], audit: null },
  diff: { permissions: ['api:read'], audit: null },
  apply: { permissions: ['api:update'], audit: 'api:updated' },
  dismiss: { permissions: ['api:update'], audit: 'api:updated' },
};
const UPDATES_ROUTES: Record<string, { permissions: string[]; audit: string | null }> = {
  list: { permissions: ['api:read'], audit: null },
};

const handlersOf = (controller: { prototype: object }): string[] =>
  Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor');
const handler = (controller: { prototype: object }, name: string): (() => unknown) =>
  (controller.prototype as Record<string, () => unknown>)[name] as () => unknown;

describe.each([
  ['SpecSourceController', SpecSourceController, SOURCE_ROUTES, 'apis'],
  ['SpecUpdatesController', SpecUpdatesController, UPDATES_ROUTES, 'spec-updates'],
])('%s wiring', (_name, controller, routes, path) => {
  it('has no route without a declared permission', () => {
    expect(handlersOf(controller).sort()).toEqual(Object.keys(routes).sort());
  });

  it.each(Object.entries(routes))('%s carries its permissions and audit decision', (name, expected) => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler(controller, name))).toEqual(expected.permissions);
    expect((Reflect.getMetadata(AUDIT_KEY, handler(controller, name)) as { action?: string } | undefined)?.action ?? null).toBe(expected.audit);
  });

  it('is guarded by tenant isolation and permissions on the whole controller', () => {
    expect(Reflect.getMetadata('__guards__', controller)).toEqual(expect.arrayContaining([TenantIsolationGuard, PermissionsGuard]));
    expect(Reflect.getMetadata('path', controller)).toBe(path);
  });
});
