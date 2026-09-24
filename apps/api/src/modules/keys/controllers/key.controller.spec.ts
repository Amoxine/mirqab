import 'reflect-metadata';
import { AUDIT_KEY } from '../../../common/decorators/audit.decorator';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { KeyController } from './key.controller';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

/** Every route the controller exposes and the permission (and audit action) it must carry. */
const ROUTES: Record<string, { permission: string; audit?: string }> = {
  create: { permission: 'key:create', audit: 'key:created' },
  findAll: { permission: 'key:read' },
  findOne: { permission: 'key:read' },
  update: { permission: 'key:update', audit: 'key:updated' },
  revoke: { permission: 'key:revoke', audit: 'key:revoked' },
  getUsage: { permission: 'key:read' },
  // WP19 (U11). `remove` is gated on key:revoke, not an invented key:delete — the permission
  // catalogue has no such entry, and this WP wasn't authorized to add one.
  rotate: { permission: 'key:update', audit: 'key:rotated' },
  resetUsage: { permission: 'key:update', audit: 'key:usage_reset' },
  remove: { permission: 'key:revoke', audit: 'key:deleted' },
};

describe('KeyController wiring', () => {
  const handlers = Object.getOwnPropertyNames(KeyController.prototype).filter((name) => name !== 'constructor');

  it('has no route without a declared permission', () => {
    expect(handlers.sort()).toEqual(Object.keys(ROUTES).sort());
  });

  it.each(Object.entries(ROUTES))('%s requires its permission and audit action', (name, expected) => {
    const handler = (KeyController.prototype as unknown as Record<string, () => unknown>)[name];
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([expected.permission]);
    expect((Reflect.getMetadata(AUDIT_KEY, handler) as { action: string } | undefined)?.action).toBe(expected.audit);
  });

  it('enforces permissions with PermissionsGuard on the whole controller', () => {
    const guards = Reflect.getMetadata('__guards__', KeyController) as unknown[];
    expect(guards).toContain(PermissionsGuard);
  });
});
