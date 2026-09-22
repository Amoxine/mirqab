import { IsIn, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Roles a tenant admin may hand out through `POST /tenants/:id/users` and
 * `PATCH /tenants/:id/users/:userId`. Exported so update-member-role.dto.ts shares the same list
 * rather than re-declaring it.
 *
 * `super_admin` is deliberately NOT here, even though seed.ts grants it to the installation's first
 * admin. It is a system-wide bypass keyed on the role name alone (isSuperAdmin in common/types),
 * not scoped to a tenant: PermissionsGuard returns early for it and TenantService.assertMember
 * waves it through every tenant. Leaving it assignable let any tenant admin grant it to a second
 * account inside their own tenant and have that account bypass every check installation-wide —
 * including the two permissions their own `admin` role is denied (tenant:delete, role:delete, see
 * DEFAULT_TENANT_ROLE_PERMISSIONS). The only super_admin is the seeded one, written straight to
 * UserTenant by seed.ts, which never goes through this DTO.
 */
export const ASSIGNABLE_ROLES = ['admin', 'operator', 'viewer'] as const;

/**
 * Body of `POST /tenants/:id/users`. This used to be an inline `{ userId: string; role: string }`
 * type, which ValidationPipe cannot validate — any string landed in `UserTenant.role`, and a role
 * that matches no seeded Role row yields a member with zero permissions.
 */
export class AssignUserDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ enum: ASSIGNABLE_ROLES })
  @IsIn(ASSIGNABLE_ROLES)
  role!: (typeof ASSIGNABLE_ROLES)[number];
}
