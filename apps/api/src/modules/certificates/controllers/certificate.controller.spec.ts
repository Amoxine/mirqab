import 'reflect-metadata';
import { AUDIT_KEY } from '../../../common/decorators/audit.decorator';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { CertificateController } from './certificate.controller';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

/** Every route the controller exposes and the permission (and audit action) it must carry. */
const ROUTES: Record<string, { permission: string; audit?: string }> = {
  findAll: { permission: 'cert:read' },
  create: { permission: 'cert:create', audit: 'cert:created' },
  remove: { permission: 'cert:delete', audit: 'cert:deleted' },
};

describe('CertificateController wiring', () => {
  const handlers = Object.getOwnPropertyNames(CertificateController.prototype).filter(
    (name) => name !== 'constructor',
  );

  it('has no route without a declared permission', () => {
    expect(handlers.sort()).toEqual(Object.keys(ROUTES).sort());
  });

  it.each(Object.entries(ROUTES))('%s requires its permission and audit action', (name, expected) => {
    const handler = (CertificateController.prototype as unknown as Record<string, () => unknown>)[name];
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([expected.permission]);
    expect((Reflect.getMetadata(AUDIT_KEY, handler) as { action: string } | undefined)?.action).toBe(expected.audit);
  });

  it('enforces permissions with PermissionsGuard on the whole controller', () => {
    const guards = Reflect.getMetadata('__guards__', CertificateController) as unknown[];
    expect(guards).toContain(PermissionsGuard);
  });
});
