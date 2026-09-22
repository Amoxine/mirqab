import { randomUUID } from 'node:crypto';
import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  TenantStatus,
  TenantPlan,
  Prisma,
} from '@prisma/client';
import { prisma, tykOrgIdFor } from '@open-gateway/database';
import { CreateTenantDto } from '../dto/create-tenant.dto';
import { UpdateTenantDto } from '../dto/update-tenant.dto';
import { PaginationDto, PaginationMeta } from '../dto/pagination.dto';
import {
  TenantResponseDto,
  TenantUserResponseDto,
  UserLookupResponseDto,
} from '../dto/tenant-response.dto';
import { isSuperAdmin, UserPayload } from '../../../common/types';
import {
  ketoCheck,
  ketoDeleteMembership,
  ketoWriteMembership,
  relationForRole,
  type TenantPermit,
} from '../../../common/ory/keto';

/**
 * Default roles seeded for every NEW tenant, mirroring packages/database/prisma/seed.ts's
 * ROLE_DEFINITIONS for the `default` tenant (kept in sync by hand — the permission catalog is seed
 * data, not app code, so there's nothing to import from). `super_admin` is deliberately excluded: it
 * is a system-wide bypass keyed only on the role name (see isSuperAdmin), so auto-granting every
 * tenant creator a same-named role would let them escalate to every OTHER tenant too.
 *
 * These rows stayed after Keto landed (WP2): Keto answers whether a subject belongs to a tenant,
 * Postgres answers which of the 27 permission names the role it holds there grants. Tenant creation
 * writes both — these rows and the creator's membership tuple.
 */
const DEFAULT_TENANT_ROLE_PERMISSIONS: Record<string, (permission: { name: string; action: string }) => boolean> = {
  admin: (p) => !['tenant:delete', 'role:delete'].includes(p.name),
  operator: (p) =>
    [
      'api:read',
      'api:create',
      'api:update',
      'key:read',
      'key:create',
      'key:update',
      'key:revoke',
      'user:read',
      'role:read',
      'analytics:read',
      'audit:read',
      'settings:read',
    ].includes(p.name),
  viewer: (p) => p.action === 'read' || p.action === 'export',
};

@Injectable()
export class TenantService {
  private readonly prisma = prisma;

  /**
   * The gate on every `:id` route: the caller must belong to THAT tenant (UserTenant) and Keto must
   * grant them `permit` on it — `view` to read, `manage` to write. super_admin bypasses both.
   *
   * Membership alone was not enough. PermissionsGuard answers "does the caller hold tenant:update?"
   * from the session, and the session's permissions come from the caller's ACTIVE tenant
   * (AuthService#resolveSession), not from the `:id` in the path. So an admin of tenant A who was
   * merely a viewer-member of tenant B cleared the guard with A's permissions and this check with
   * B's row, and could `PATCH /tenants/B/users/<self> {"role":"admin"}` — self-promotion in B with
   * no header forgery and no failure precondition. Asking Keto about the tenant actually being acted
   * on re-anchors the decision there.
   *
   * Reads also go through Keto, so a membership row whose tuple never landed (see the compensation
   * in create()/assignUser()) is denied rather than half-trusted.
   */
  private async assertPermit(
    caller: UserPayload,
    tenantId: string,
    permit: TenantPermit,
  ): Promise<void> {
    if (isSuperAdmin(caller.roles)) return;

    const membership = await this.prisma.userTenant.findUnique({
      where: { userId_tenantId: { userId: caller.sub, tenantId } },
      select: { userId: true },
    });

    if (!membership) {
      // Deliberately not 404: which tenant ids exist is not the caller's business either.
      throw new ForbiddenException('Access denied: you are not a member of this tenant');
    }

    if (!(await ketoCheck(tenantId, permit, caller.sub))) {
      throw new ForbiddenException(
        permit === 'manage'
          ? 'Access denied: you are not an admin of this tenant'
          : 'Access denied: you do not have access to this tenant',
      );
    }
  }

  /**
   * True when `userId` is the only admin-relation member of `tenantId` — changing their role away
   * from admin, or removing them, would leave the tenant with nobody who can manage it.
   */
  private async isLastAdmin(tenantId: string, userId: string): Promise<boolean> {
    const members = await this.prisma.userTenant.findMany({
      where: { tenantId },
      select: { userId: true, role: true },
    });
    const admins = members.filter((m) => relationForRole(m.role) === 'admin');
    return admins.length === 1 && admins[0].userId === userId;
  }

  /**
   * Create a new tenant with a UserTenant entry for the creator.
   * Transactional — both Tenant and UserTenant are created in one transaction.
   */
  async create(
    dto: CreateTenantDto,
    creator: UserPayload,
  ): Promise<TenantResponseDto> {
    // Normalize slug: lowercase, trim
    const normalizedSlug = dto.slug.toLowerCase().trim();

    // Validate slug format
    const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    if (!slugPattern.test(normalizedSlug)) {
      throw new BadRequestException(
        'Slug must be lowercase alphanumeric with hyphens only',
      );
    }

    // Transactional create: Tenant + UserTenant
    const tenant = await this.prisma.$transaction(async (tx) => {
      // Check slug uniqueness explicitly (for better error message)
      const existing = await tx.tenant.findUnique({
        where: { slug: normalizedSlug },
        select: { id: true },
      });

      if (existing) {
        throw new ConflictException(
          `Tenant with slug "${normalizedSlug}" already exists`,
        );
      }

      // The Tyk org is derived from the tenant's own id, so the id is generated here rather than
      // by the database default — Postgres cannot reference another column in a DEFAULT, and a
      // tenant must never exist without an org to stamp its gateway state with.
      const id = randomUUID();

      // Create the tenant
      const newTenant = await tx.tenant.create({
        data: {
          id,
          tykOrgId: tykOrgIdFor(id),
          name: dto.name,
          slug: normalizedSlug,
          plan: dto.plan ?? TenantPlan.FREE,
          ...(dto.config && { config: dto.config as Prisma.InputJsonValue }),
        },
      });

      // Create UserTenant entry for the creator with 'admin' role
      await tx.userTenant.create({
        data: {
          userId: creator.sub,
          tenantId: newTenant.id,
          role: 'admin',
          isDefault: true,
        },
      });

      // A tenant with a UserTenant row but no Role row is unusable by anyone but super_admin:
      // AuthService#loadPermissions looks up Role by (name, tenantId) and finds nothing, so the
      // creator's own token carries the 'admin' role label with zero permissions. Seed the same
      // default roles seed.ts creates for the `default` tenant (see DEFAULT_TENANT_ROLE_PERMISSIONS).
      const allPermissions = await tx.permission.findMany();
      for (const [roleName, grantsPermission] of Object.entries(DEFAULT_TENANT_ROLE_PERMISSIONS)) {
        const role = await tx.role.create({
          data: { name: roleName, tenantId: newTenant.id },
        });
        const granted = allPermissions.filter(grantsPermission);
        if (granted.length > 0) {
          await tx.rolePermission.createMany({
            data: granted.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
          });
        }
      }

      return newTenant;
    });

    // Written after the commit, not inside it: Keto is a separate store with no share in this
    // transaction. Without the tuple the creator would be a member in Postgres that AuthService's
    // Keto check denies — i.e. locked out of the tenant they just made, and unable to make it again
    // because the slug is now taken (the ConflictException above). So the failure path compensates
    // rather than reporting a 500 over committed state: deleting the tenant takes its UserTenant,
    // Role and RolePermission rows with it (onDelete: Cascade, schema.prisma) and leaves the whole
    // create retryable.
    try {
      await ketoWriteMembership(tenant.id, 'admin', creator.sub);
    } catch (error) {
      await this.prisma.tenant.delete({ where: { id: tenant.id } });
      throw new BadGatewayException(
        'Tenant could not be created: the authorization service is unavailable. Nothing was kept — try again.',
        { cause: error },
      );
    }

    return TenantResponseDto.fromTenant(tenant);
  }

  /**
   * List the caller's tenants with pagination (every tenant, for super_admin).
   * Returns paginated results with total count.
   */
  async findAll(
    pagination: PaginationDto,
    caller: UserPayload,
  ): Promise<{ data: TenantResponseDto[]; meta: PaginationMeta }> {
    const page = pagination.page ?? 1;
    const pageSize = pagination.pageSize ?? 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.TenantWhereInput = isSuperAdmin(caller.roles)
      ? {}
      : { userTenants: { some: { userId: caller.sub } } };

    const [tenants, totalCount] = await this.prisma.$transaction([
      this.prisma.tenant.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.tenant.count({ where }),
    ]);

    const totalPages = Math.ceil(totalCount / pageSize);

    return {
      data: tenants.map((t) => TenantResponseDto.fromTenant(t)),
      meta: {
        page,
        pageSize,
        totalCount,
        totalPages,
      },
    };
  }

  /**
   * Get a single tenant by ID. Requires membership (or super_admin).
   * Throws NotFoundException if not found.
   */
  async findOne(id: string, caller: UserPayload): Promise<TenantResponseDto> {
    await this.assertPermit(caller, id, 'view');

    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with ID "${id}" not found`);
    }

    return TenantResponseDto.fromTenant(tenant);
  }

  /**
   * Get a single tenant by slug.
   * Throws NotFoundException if not found.
   */
  async findOneBySlug(slug: string): Promise<TenantResponseDto> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with slug "${slug}" not found`);
    }

    return TenantResponseDto.fromTenant(tenant);
  }

  /**
   * Update a tenant with partial data.
   * Only provided fields are updated.
   */
  async update(
    id: string,
    dto: UpdateTenantDto,
    caller: UserPayload,
  ): Promise<TenantResponseDto> {
    await this.assertPermit(caller, id, 'manage');

    // Check existence first
    const existing = await this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException(`Tenant with ID "${id}" not found`);
    }

    // If updating slug, validate and normalize
    if (dto.slug !== undefined) {
      const normalizedSlug = dto.slug.toLowerCase().trim();
      const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
      if (!slugPattern.test(normalizedSlug)) {
        throw new BadRequestException(
          'Slug must be lowercase alphanumeric with hyphens only',
        );
      }

      // Check slug uniqueness
      const slugConflict = await this.prisma.tenant.findUnique({
        where: { slug: normalizedSlug },
        select: { id: true },
      });

      if (slugConflict && slugConflict.id !== id) {
        throw new ConflictException(
          `Tenant with slug "${normalizedSlug}" already exists`,
        );
      }
    }

    const updatedTenant = await this.prisma.tenant.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.plan !== undefined && { plan: dto.plan }),
        ...(dto.config !== undefined && {
          config: dto.config as Prisma.InputJsonValue,
        }),
      },
    });

    return TenantResponseDto.fromTenant(updatedTenant);
  }

  /**
   * Soft delete a tenant by setting status to ARCHIVED.
   */
  async archive(id: string, caller: UserPayload): Promise<TenantResponseDto> {
    await this.assertPermit(caller, id, 'manage');

    const existing = await this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true, status: true },
    });

    if (!existing) {
      throw new NotFoundException(`Tenant with ID "${id}" not found`);
    }

    if (existing.status === TenantStatus.ARCHIVED) {
      throw new BadRequestException(`Tenant is already archived`);
    }

    const archived = await this.prisma.tenant.update({
      where: { id },
      data: { status: TenantStatus.ARCHIVED },
    });

    return TenantResponseDto.fromTenant(archived);
  }

  /**
   * List all users assigned to a tenant. Requires membership (or super_admin).
   */
  async findUsers(tenantId: string, caller: UserPayload): Promise<TenantUserResponseDto[]> {
    await this.assertPermit(caller, tenantId, 'view');

    // Verify tenant exists
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with ID "${tenantId}" not found`);
    }

    const userTenants = await this.prisma.userTenant.findMany({
      where: { tenantId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return userTenants.map((ut) => ({
      userId: ut.userId,
      email: ut.user.email,
      name: ut.user.name,
      role: ut.role,
      isDefault: ut.isDefault,
      createdAt: ut.createdAt,
    }));
  }

  /**
   * Assign a user to a tenant with a specific role.
   */
  async assignUser(
    tenantId: string,
    userId: string,
    role: string,
    caller: UserPayload,
  ): Promise<TenantUserResponseDto> {
    await this.assertPermit(caller, tenantId, 'manage');

    // Verify tenant exists
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with ID "${tenantId}" not found`);
    }

    // Verify user exists
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true },
    });

    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found`);
    }

    // Check if already assigned
    const existing = await this.prisma.userTenant.findUnique({
      where: {
        userId_tenantId: { userId, tenantId },
      },
    });

    if (existing) {
      throw new ConflictException(
        `User "${userId}" is already assigned to tenant "${tenantId}"`,
      );
    }

    const userTenant = await this.prisma.userTenant.create({
      data: {
        userId,
        tenantId,
        role,
        isDefault: false,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    // Same reason as in create(): the membership row is only half the record — the Keto tuple is
    // what AuthService checks before it puts the tenant in the caller's session. Same compensation
    // too, since the "already assigned" conflict above would otherwise block every retry of an
    // assignment that Keto denies.
    try {
      await ketoWriteMembership(tenantId, relationForRole(role), userId);
    } catch (error) {
      await this.prisma.userTenant.delete({ where: { userId_tenantId: { userId, tenantId } } });
      throw new BadGatewayException(
        'User could not be assigned: the authorization service is unavailable. Nothing was kept — try again.',
        { cause: error },
      );
    }

    return {
      userId: userTenant.userId,
      email: userTenant.user.email,
      name: userTenant.user.name,
      role: userTenant.role,
      isDefault: userTenant.isDefault,
      createdAt: userTenant.createdAt,
    };
  }

  /**
   * Finds an existing Open Gateway user by email, for an admin inviting them into `tenantId`.
   * Requires membership in that tenant (same as every other read here) so this can't be used as a
   * general user directory across tenants the caller isn't in.
   *
   * Returns null for no match rather than 404 — a search with zero results isn't an error. The
   * common case is a user who has signed in at least once: the Postgres `User` row is provisioned
   * lazily on first login (apps/web's oauth2/login route), so someone who only registered in Kratos
   * and never logged in has no row yet and can't be found here — the invite UI surfaces that as
   * "ask them to log in once first", not a 500.
   */
  async lookupUserByEmail(
    tenantId: string,
    email: string,
    caller: UserPayload,
  ): Promise<UserLookupResponseDto | null> {
    await this.assertPermit(caller, tenantId, 'view');

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true },
    });
    if (!user) return null;

    const membership = await this.prisma.userTenant.findUnique({
      where: { userId_tenantId: { userId: user.id, tenantId } },
      select: { userId: true },
    });

    return { ...user, isMember: !!membership };
  }

  /**
   * Changes a member's role. Keto only tracks the coarse admin/member relation (relationForRole),
   * so the tuple is only touched when the relation actually changes (e.g. operator -> viewer is a
   * Postgres-only change). When it does change, delete the old tuple before writing the new one —
   * see keto.ts's ketoDeleteMembership: a write-then-delete would leave the OLD relation granting
   * access for however long the delete takes.
   *
   * Which store goes first decides which way a half-applied change fails, and the two directions
   * are not symmetric:
   *  - PROMOTION (member -> admin) writes Keto first. A failure between the delete and the write
   *    leaves no tuple at all, so Keto denies everything — fail closed — and the untouched row makes
   *    a retry a clean replay.
   *  - DEMOTION (admin -> member) writes Postgres first. The 27 permission names come from the ROW
   *    (AuthService#loadPermissions); Keto only answers membership and `manage`. Keto-first
   *    therefore failed OPEN: the tuple was demoted, the Postgres update then failed, and the
   *    subject kept every admin permission. Writing the row first drops those immediately, and if
   *    the tuple sync then fails the row is rolled back so the stores stay consistent — leaving it
   *    demoted would make a retry a no-op (old relation == new relation) that never cleans up the
   *    stale `admin` tuple.
   */
  async updateMemberRole(
    tenantId: string,
    userId: string,
    role: string,
    caller: UserPayload,
  ): Promise<TenantUserResponseDto> {
    await this.assertPermit(caller, tenantId, 'manage');

    const existing = await this.prisma.userTenant.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
    });
    if (!existing) {
      throw new NotFoundException(`User "${userId}" is not a member of tenant "${tenantId}"`);
    }

    const oldRelation = relationForRole(existing.role);
    const newRelation = relationForRole(role);
    if (
      oldRelation === 'admin' &&
      newRelation !== 'admin' &&
      (await this.isLastAdmin(tenantId, userId))
    ) {
      throw new BadRequestException('Cannot change role: this is the last admin of the tenant');
    }

    const syncKetoRelation = async (): Promise<void> => {
      if (oldRelation === newRelation) return;
      await ketoDeleteMembership(tenantId, oldRelation, userId);
      await ketoWriteMembership(tenantId, newRelation, userId);
    };

    const isDemotion = oldRelation === 'admin' && newRelation !== 'admin';
    if (!isDemotion) {
      await syncKetoRelation();
    }

    const updated = await this.prisma.userTenant.update({
      where: { userId_tenantId: { userId, tenantId } },
      data: { role },
      include: { user: { select: { id: true, email: true, name: true } } },
    });

    if (isDemotion) {
      try {
        await syncKetoRelation();
      } catch (error) {
        await this.prisma.userTenant.update({
          where: { userId_tenantId: { userId, tenantId } },
          data: { role: existing.role },
        });
        throw new BadGatewayException(
          'Role could not be changed: the authorization service is unavailable. The role was left unchanged — try again.',
          { cause: error },
        );
      }
    }

    return {
      userId: updated.userId,
      email: updated.user.email,
      name: updated.user.name,
      role: updated.role,
      isDefault: updated.isDefault,
      createdAt: updated.createdAt,
    };
  }

  /**
   * Removes a member from the tenant. The Keto tuple is deleted BEFORE the Postgres row for the
   * same fail-closed reason as updateMemberRole: if the Postgres delete then fails, the member
   * looks assigned but Keto already denies them — never the reverse.
   */
  async removeMember(tenantId: string, userId: string, caller: UserPayload): Promise<void> {
    await this.assertPermit(caller, tenantId, 'manage');

    const existing = await this.prisma.userTenant.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      select: { role: true },
    });
    if (!existing) {
      throw new NotFoundException(`User "${userId}" is not a member of tenant "${tenantId}"`);
    }

    if (relationForRole(existing.role) === 'admin' && (await this.isLastAdmin(tenantId, userId))) {
      throw new BadRequestException('Cannot remove the last admin of the tenant');
    }

    await ketoDeleteMembership(tenantId, relationForRole(existing.role), userId);
    await this.prisma.userTenant.delete({ where: { userId_tenantId: { userId, tenantId } } });
  }
}
