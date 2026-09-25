import 'reflect-metadata';
import { AUDIT_KEY } from '../../../common/decorators/audit.decorator';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { ApiImportController } from './api-import.controller';
import { ApiSpecController } from './api-spec.controller';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

/**
 * Every route of the two OpenAPI controllers and the permissions it must carry. A new handler that is
 * not listed here fails the first test, so a route cannot ship without its permission being decided.
 */
const IMPORT_ROUTES: Record<string, { permissions: string[]; audited: boolean }> = {
  import: { permissions: ['api:create'], audited: true },
  // The preview changes nothing, so it is not audited — but it needs the same permission as the real import.
  preview: { permissions: ['api:create'], audited: false },
};
const SPEC_ROUTES: Record<string, { permissions: string[]; audited: boolean }> = {
  spec: { permissions: ['api:read'], audited: false },
  endpoints: { permissions: ['api:read'], audited: false },
  // OAS-03: the governance write changes the API, so it is audited like any other API update.
  updateEndpoints: { permissions: ['api:update'], audited: true },
};

const handlersOf = (controller: { prototype: object }): string[] =>
  Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor');
const handler = (controller: { prototype: object }, name: string): (() => unknown) =>
  (controller.prototype as Record<string, () => unknown>)[name] as () => unknown;

describe('ApiImportController wiring', () => {
  it('has no route without a declared permission', () => {
    expect(handlersOf(ApiImportController).sort()).toEqual(Object.keys(IMPORT_ROUTES).sort());
  });

  it.each(Object.entries(IMPORT_ROUTES))('%s carries its permissions and audit decision', (name, expected) => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler(ApiImportController, name))).toEqual(expected.permissions);
    expect(Reflect.getMetadata(AUDIT_KEY, handler(ApiImportController, name)) !== undefined).toBe(expected.audited);
  });

  it('is guarded by tenant isolation and permissions on the whole controller', () => {
    expect(Reflect.getMetadata('__guards__', ApiImportController)).toEqual(
      expect.arrayContaining([TenantIsolationGuard, PermissionsGuard]),
    );
  });
});

describe('ApiSpecController wiring', () => {
  it('has no route without a declared permission', () => {
    expect(handlersOf(ApiSpecController).sort()).toEqual(Object.keys(SPEC_ROUTES).sort());
  });

  it.each(Object.entries(SPEC_ROUTES))('%s requires its permissions and audit decision', (name, expected) => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler(ApiSpecController, name))).toEqual(expected.permissions);
    expect(Reflect.getMetadata(AUDIT_KEY, handler(ApiSpecController, name)) !== undefined).toBe(expected.audited);
  });

  it('audits the governance write as an API update', () => {
    expect(Reflect.getMetadata(AUDIT_KEY, handler(ApiSpecController, 'updateEndpoints'))).toMatchObject({ action: 'api:updated' });
  });

  it('is guarded by tenant isolation and permissions on the whole controller', () => {
    expect(Reflect.getMetadata('__guards__', ApiSpecController)).toEqual(
      expect.arrayContaining([TenantIsolationGuard, PermissionsGuard]),
    );
  });
});
