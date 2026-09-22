import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import { ketoCheck } from '../../../common/ory/keto';
import type { RoleType, UserPayload, UserStatusType } from '../../../common/types';

/** A user's membership rows, narrowed to what a session needs. */
interface Membership {
  tenantId: string;
  role: string;
  isDefault: boolean;
}

/**
 * The single tenant a session acts in: the one asked for by `X-Tenant-ID` if the caller is in it,
 * else the one flagged default, else the first membership.
 *
 * Everything in the session (roles, permissions, tenantId) is derived from THIS tenant. Roles used
 * to be the union across all of the user's tenants while permissions came from the default one
 * only, so being super_admin in tenant B silently bypassed every check in tenant A. An unknown
 * requested tenant deliberately does NOT fall through to an error here — it falls back to the
 * default, and TenantIsolationGuard turns the header/session mismatch into a 403.
 */
const pickActiveTenant = <T extends Membership>(
  memberships: T[],
  requestedTenantId: string | undefined,
): T | undefined =>
  (requestedTenantId === undefined
    ? undefined
    : memberships.find((m) => m.tenantId === requestedTenantId)) ??
  memberships.find((m) => m.isDefault) ??
  memberships.at(0);

@Injectable()
export class AuthService {
  // Shared singleton from @open-gateway/database: `new PrismaClient()` here opened a second pool
  // that was never disconnected.
  private readonly prisma = prisma;

  /**
   * Turns a verified token subject into the session the guards read, or null when there is nothing
   * to act as (401).
   *
   * The subject is this app's `User.id` — the login/consent app (WP3) accepts Hydra's login
   * challenge with that id as the subject, so no Kratos-identity-to-user mapping is needed here.
   * A token whose subject is not a local user (a client_credentials token aimed at the data plane)
   * therefore resolves to null rather than to a half-populated session.
   *
   * Membership is confirmed against Keto, not against the row that was just read: Postgres keeps
   * WHICH role you hold in a tenant (that is what maps to the 27 permission names), Keto answers
   * WHETHER you belong to it at all. A membership with no tuple is denied — see TenantService,
   * which writes the tuple for every row it creates.
   */
  async resolveSession(
    subject: string,
    requestedTenantId?: string,
  ): Promise<UserPayload | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: subject },
      include: { userTenants: { select: { tenantId: true, role: true, isDefault: true } } },
    });

    if (user?.status !== 'ACTIVE') {
      return null;
    }

    const candidate = pickActiveTenant(user.userTenants, requestedTenantId);
    const active =
      candidate && (await ketoCheck(candidate.tenantId, 'view', user.id)) ? candidate : undefined;

    return {
      sub: user.id,
      email: user.email,
      // `UserTenant.role` is a free-form text column; RoleType names the values the seed writes.
      roles: active ? [active.role as RoleType] : [],
      ...(active && { tenantId: active.tenantId }),
      status: user.status as UserStatusType,
      permissions: await this.loadPermissions(active),
    };
  }

  /**
   * `GET /auth/me`. Roles, permissions and the active tenant come from the session the strategy
   * already resolved for this request; only the profile fields and the full tenant list need a
   * query.
   */
  async getCurrentUser(user: UserPayload): Promise<{
    id: string;
    email: string;
    name: string;
    /** Roles in the active tenant only — same scope as the session's. */
    roles: string[];
    permissions: string[];
    tenants: { tenantId: string; role: string; name: string }[];
    /** Name of the active tenant, for display; null when the user has none. */
    tenantName: string | null;
  }> {
    const row = await this.prisma.user.findUnique({
      where: { id: user.sub },
      include: {
        userTenants: {
          select: { tenantId: true, role: true, tenant: { select: { name: true } } },
        },
      },
    });

    if (!row) {
      throw new NotFoundException('User not found');
    }

    return {
      id: row.id,
      email: row.email,
      name: row.name,
      roles: user.roles,
      permissions: user.permissions ?? [],
      // Every membership, so the UI can still offer a tenant switcher.
      tenants: row.userTenants.map(({ tenantId, role, tenant }) => ({
        tenantId,
        role,
        name: tenant.name,
      })),
      tenantName:
        row.userTenants.find((t) => t.tenantId === user.tenantId)?.tenant.name ?? null,
    };
  }

  /**
   * Permission names granted by the user's role in a tenant:
   * UserTenant.role -> Role(name, tenantId) -> RolePermission -> Permission.name.
   */
  private async loadPermissions(
    userTenant: { tenantId: string; role: string } | undefined,
  ): Promise<string[]> {
    if (!userTenant) return [];

    const role = await this.prisma.role.findUnique({
      where: { name_tenantId: { name: userTenant.role, tenantId: userTenant.tenantId } },
      select: { permissions: { select: { permission: { select: { name: true } } } } },
    });

    return role?.permissions.map((rp) => rp.permission.name) ?? [];
  }
}
