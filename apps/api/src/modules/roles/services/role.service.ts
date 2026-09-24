import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { SUPER_ADMIN_ROLE } from '../../../common/types';
import type { CreateRoleDto, UpdateRoleDto } from '../dto/role.dto';

export interface RoleDetail {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  /** How many members of this tenant currently hold this role by name — `DELETE` refuses while > 0. */
  memberCount: number;
  createdAt: Date;
}

export interface PermissionCatalogEntry {
  name: string;
  resource: string;
  action: string;
}

const isReserved = (name: string): boolean => name.trim().toLowerCase() === SUPER_ADMIN_ROLE;

const reservedRoleError = (): ForbiddenException =>
  new ForbiddenException(`"${SUPER_ADMIN_ROLE}" is a system-wide role and cannot be managed here`);

const withPermissions = { permissions: { include: { permission: true } } } satisfies Prisma.RoleInclude;
type RoleRow = Prisma.RoleGetPayload<{ include: typeof withPermissions }>;

const nameTaken = (name: string): string => `A role named "${name}" already exists in this tenant.`;

/**
 * Custom roles per tenant (U18): CRUD on `Role` + `RolePermission`.
 *
 * `UserTenant.role` is matched against `Role.name` by plain string equality, not a foreign key (see
 * AuthService#loadPermissions), and `isSuperAdmin` matches that same string globally with no tenant
 * scoping (PermissionsGuard, TenantService#assertPermit). So `super_admin` is not a permission this
 * matrix could over-grant — it is a RESERVED NAME: creating, renaming to, or touching a role called
 * that (case-insensitively, in ANY tenant) would hand out the platform-wide bypass regardless of
 * which permissions the row itself carries. Every mutation below rejects it with 403, structurally —
 * there is no permission combination that reaches it, matching TenantService's matching guard on
 * `assignUser`/`updateMemberRole` (the other half of this escalation).
 */
@Injectable()
export class RoleService {
  private async toDetail(row: RoleRow, tenantId: string): Promise<RoleDetail> {
    const memberCount = await prisma.userTenant.count({ where: { tenantId, role: row.name } });
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      permissions: row.permissions.map((rp) => rp.permission.name),
      memberCount,
      createdAt: row.createdAt,
    };
  }

  /** Every name must exist in the catalogue — an unknown permission is a 400, never silently dropped. */
  private async resolvePermissionIds(names: string[]): Promise<string[]> {
    const unique = [...new Set(names)];
    if (unique.length === 0) return [];

    const rows = await prisma.permission.findMany({
      where: { name: { in: unique } },
      select: { id: true, name: true },
    });
    const missing = unique.filter((name) => !rows.some((row) => row.name === name));
    if (missing.length > 0) {
      throw new BadRequestException(`Unknown permission(s): ${missing.join(', ')}`);
    }
    return rows.map((row) => row.id);
  }

  async permissionCatalog(): Promise<PermissionCatalogEntry[]> {
    return prisma.permission.findMany({
      select: { name: true, resource: true, action: true },
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
  }

  async findAll(tenantId: string): Promise<RoleDetail[]> {
    const rows = await prisma.role.findMany({
      where: { tenantId },
      include: withPermissions,
      orderBy: { name: 'asc' },
    });
    return Promise.all(rows.map((row) => this.toDetail(row, tenantId)));
  }

  async findOne(id: string, tenantId: string): Promise<RoleDetail> {
    return this.toDetail(await this.findRow(id, tenantId), tenantId);
  }

  async create(dto: CreateRoleDto, tenantId: string): Promise<RoleDetail> {
    if (isReserved(dto.name)) throw reservedRoleError();
    const permissionIds = await this.resolvePermissionIds(dto.permissions);

    let row: RoleRow;
    try {
      row = await prisma.role.create({
        data: {
          name: dto.name,
          description: dto.description,
          tenantId,
          permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) },
        },
        include: withPermissions,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(nameTaken(dto.name));
      }
      throw err;
    }
    return this.toDetail(row, tenantId);
  }

  /**
   * Edit a role's description/permissions, or rename it. Sending `permissions` replaces the whole
   * grant (same convention as `Product.apiIds`); omitting it leaves the existing grant untouched.
   */
  async update(id: string, dto: UpdateRoleDto, tenantId: string): Promise<RoleDetail> {
    const existing = await this.findRow(id, tenantId);
    if (isReserved(existing.name)) throw reservedRoleError();
    if (dto.name !== undefined && isReserved(dto.name)) throw reservedRoleError();

    const permissionIds = dto.permissions !== undefined ? await this.resolvePermissionIds(dto.permissions) : null;

    let row: RoleRow;
    try {
      row = await prisma.$transaction(async (tx) => {
        if (permissionIds !== null) {
          await tx.rolePermission.deleteMany({ where: { roleId: id } });
          if (permissionIds.length > 0) {
            await tx.rolePermission.createMany({
              data: permissionIds.map((permissionId) => ({ roleId: id, permissionId })),
            });
          }
        }
        return tx.role.update({
          where: { id },
          data: { name: dto.name, description: dto.description },
          include: withPermissions,
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(nameTaken(dto.name ?? existing.name));
      }
      throw err;
    }
    return this.toDetail(row, tenantId);
  }

  /**
   * Delete a role. Refused while any member still holds it by name — `Role` has no foreign key from
   * `UserTenant.role` (it is a free string), so deleting it out from under active members would not
   * fail loudly; it would silently zero their permissions on their next request (AuthService#loadPermissions
   * finds no matching Role row). Reassign those members first.
   */
  async remove(id: string, tenantId: string): Promise<{ message: string }> {
    const row = await this.findRow(id, tenantId);
    if (isReserved(row.name)) throw reservedRoleError();

    const inUse = await prisma.userTenant.count({ where: { tenantId, role: row.name } });
    if (inUse > 0) {
      throw new ConflictException(
        `Role "${row.name}" is assigned to ${String(inUse)} member(s); reassign them before deleting it.`,
      );
    }

    await prisma.role.delete({ where: { id } });
    return { message: `Role "${row.name}" deleted.` };
  }

  private async findRow(id: string, tenantId: string): Promise<RoleRow> {
    const row = await prisma.role.findFirst({ where: { id, tenantId }, include: withPermissions });
    if (!row) throw new NotFoundException(`Role ${id} not found`);
    return row;
  }
}
