import 'reflect-metadata';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { GovernanceController } from './governance.controller';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

/**
 * Every route and the permission it must carry. No `@Audit()` entries here on purpose: `export` is a
 * read (no mutation to audit) and `adopt` writes its own mandatory, synchronous audit row inside
 * `GovernanceAdoptService` — see that service's doc comment for why the generic fire-and-forget
 * `@Audit()`/`AuditLogInterceptor` path is the wrong fit for it.
 */
const ROUTES: Record<string, { permission: string }> = {
  drift: { permission: 'api:read' },
  export: { permission: 'api:read' },
  adopt: { permission: 'api:update' },
};

describe('GovernanceController wiring', () => {
  const handlers = Object.getOwnPropertyNames(GovernanceController.prototype).filter(
    (name) => name !== 'constructor',
  );

  it('has no route without a declared permission', () => {
    expect(handlers.sort()).toEqual(Object.keys(ROUTES).sort());
  });

  it.each(Object.entries(ROUTES))('%s requires its permission', (name, expected) => {
    const handler = (GovernanceController.prototype as unknown as Record<string, () => unknown>)[name];
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([expected.permission]);
  });

  it('enforces permissions with PermissionsGuard on the whole controller', () => {
    const guards = Reflect.getMetadata('__guards__', GovernanceController) as unknown[];
    expect(guards).toContain(PermissionsGuard);
  });
});
