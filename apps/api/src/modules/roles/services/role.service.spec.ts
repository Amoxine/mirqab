import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import { RoleService } from './role.service';

jest.mock('@open-gateway/database', () => {
  const role = { create: jest.fn(), update: jest.fn(), delete: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() };
  const rolePermission = { deleteMany: jest.fn(), createMany: jest.fn() };
  const permission = { findMany: jest.fn() };
  const userTenant = { count: jest.fn() };
  // Everything RoleService.update() does inside the transaction reuses these same mocks, so
  // assertions against e.g. `db.role.update` see calls made through `tx.role.update` too.
  const tx = { role, rolePermission };
  return {
    prisma: { role, rolePermission, permission, userTenant, $transaction: (fn: (tx: unknown) => unknown) => fn(tx) },
  };
});

interface MockDb {
  role: Record<'create' | 'update' | 'delete' | 'findFirst' | 'findMany', jest.Mock>;
  rolePermission: Record<'deleteMany' | 'createMany', jest.Mock>;
  permission: { findMany: jest.Mock };
  userTenant: { count: jest.Mock };
}
const db = prisma as unknown as MockDb;

const TENANT = 'tenant-1';

const permRow = (name: string) => ({ id: `perm-${name}`, name });

const roleRow = (over: Record<string, unknown> = {}) => ({
  id: 'role-1',
  name: 'billing-viewer',
  description: null,
  tenantId: TENANT,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  permissions: [{ permission: { name: 'key:read' } }],
  ...over,
});

describe('RoleService', () => {
  let service: RoleService;

  beforeEach(() => {
    jest.resetAllMocks();
    db.userTenant.count.mockResolvedValue(0);
    service = new RoleService();
  });

  describe('create', () => {
    it('rejects "super_admin" (case-insensitively) before touching the database', async () => {
      await expect(
        service.create({ name: 'super_admin', permissions: [] }, TENANT),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.create({ name: 'Super_Admin', permissions: [] }, TENANT),
      ).rejects.toThrow(ForbiddenException);
      expect(db.role.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown permission name rather than silently dropping it', async () => {
      db.permission.findMany.mockResolvedValue([permRow('key:read')]);

      await expect(
        service.create({ name: 'ops', permissions: ['key:read', 'not:a-real-permission'] }, TENANT),
      ).rejects.toThrow(BadRequestException);
      expect(db.role.create).not.toHaveBeenCalled();
    });

    it('creates the role with the resolved permission ids and reports memberCount', async () => {
      db.permission.findMany.mockResolvedValue([permRow('key:read'), permRow('plan:read')]);
      db.role.create.mockResolvedValue(
        roleRow({ permissions: [{ permission: { name: 'key:read' } }, { permission: { name: 'plan:read' } }] }),
      );
      db.userTenant.count.mockResolvedValue(2);

      const result = await service.create({ name: 'billing-viewer', permissions: ['key:read', 'plan:read'] }, TENANT);

      expect(db.role.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'billing-viewer',
            tenantId: TENANT,
            permissions: { create: [{ permissionId: 'perm-key:read' }, { permissionId: 'perm-plan:read' }] },
          }),
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({ name: 'billing-viewer', permissions: ['key:read', 'plan:read'], memberCount: 2 }),
      );
    });
  });

  describe('update', () => {
    it('rejects editing the reserved role, even just its description', async () => {
      db.role.findFirst.mockResolvedValue(roleRow({ name: 'super_admin' }));

      await expect(service.update('role-1', { description: 'x' }, TENANT)).rejects.toThrow(ForbiddenException);
      expect(db.role.update).not.toHaveBeenCalled();
    });

    it('rejects renaming a role TO the reserved name', async () => {
      db.role.findFirst.mockResolvedValue(roleRow());

      await expect(service.update('role-1', { name: 'super_admin' }, TENANT)).rejects.toThrow(ForbiddenException);
      expect(db.role.update).not.toHaveBeenCalled();
    });

    it('replaces the permission grant when `permissions` is sent, leaves it alone when omitted', async () => {
      db.role.findFirst.mockResolvedValue(roleRow());
      db.permission.findMany.mockResolvedValue([permRow('key:read')]);
      db.role.update.mockResolvedValue(roleRow());

      await service.update('role-1', { permissions: ['key:read'] }, TENANT);

      expect(db.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: 'role-1' } });
      expect(db.rolePermission.createMany).toHaveBeenCalledWith({
        data: [{ roleId: 'role-1', permissionId: 'perm-key:read' }],
      });

      db.rolePermission.deleteMany.mockClear();
      db.role.findFirst.mockResolvedValue(roleRow());
      db.role.update.mockResolvedValue(roleRow());

      await service.update('role-1', { description: 'new text' }, TENANT);
      expect(db.rolePermission.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('rejects deleting the reserved role', async () => {
      db.role.findFirst.mockResolvedValue(roleRow({ name: 'super_admin' }));

      await expect(service.remove('role-1', TENANT)).rejects.toThrow(ForbiddenException);
      expect(db.role.delete).not.toHaveBeenCalled();
    });

    it('refuses to delete a role still assigned to members', async () => {
      db.role.findFirst.mockResolvedValue(roleRow());
      db.userTenant.count.mockResolvedValue(3);

      await expect(service.remove('role-1', TENANT)).rejects.toThrow(ConflictException);
      expect(db.role.delete).not.toHaveBeenCalled();
    });

    it('deletes a role nobody holds any more', async () => {
      db.role.findFirst.mockResolvedValue(roleRow());
      db.userTenant.count.mockResolvedValue(0);

      await service.remove('role-1', TENANT);
      expect(db.role.delete).toHaveBeenCalledWith({ where: { id: 'role-1' } });
    });

    it('404s a role that does not belong to this tenant', async () => {
      db.role.findFirst.mockResolvedValue(null);

      await expect(service.remove('missing', TENANT)).rejects.toThrow(NotFoundException);
    });
  });
});
