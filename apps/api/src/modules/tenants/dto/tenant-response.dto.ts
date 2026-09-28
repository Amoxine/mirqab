import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Tenant, TenantStatus, TenantPlan } from '@prisma/client';

export class TenantResponseDto {
  @ApiProperty({ description: 'Tenant unique identifier', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Tenant display name' })
  name!: string;

  @ApiProperty({ description: 'URL-safe unique slug' })
  slug!: string;

  @ApiProperty({ description: 'Tenant status', enum: TenantStatus })
  status!: TenantStatus;

  @ApiProperty({ description: 'Subscription plan', enum: TenantPlan })
  plan!: TenantPlan;

  @ApiPropertyOptional({
    description: 'Additional configuration',
    type: 'object',
    additionalProperties: true,
  })
  config!: Record<string, unknown> | null;

  @ApiProperty({ description: 'Creation timestamp', format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ description: 'Last update timestamp', format: 'date-time' })
  updatedAt!: Date;

  /**
   * Maps a Prisma Tenant model to the response DTO
   */
  static fromTenant(tenant: Tenant): TenantResponseDto {
    const dto = new TenantResponseDto();
    dto.id = tenant.id;
    dto.name = tenant.name;
    dto.slug = tenant.slug;
    dto.status = tenant.status;
    dto.plan = tenant.plan;
    dto.config = (tenant.config as Record<string, unknown> | null) ?? null;
    dto.createdAt = tenant.createdAt;
    dto.updatedAt = tenant.updatedAt;
    return dto;
  }
}

export class TenantUserResponseDto {
  @ApiProperty({ description: 'User unique identifier', format: 'uuid' })
  userId!: string;

  @ApiProperty({ description: 'User email' })
  email!: string;

  @ApiProperty({ description: 'User display name' })
  name!: string;

  @ApiProperty({ description: 'Role within this tenant' })
  role!: string;

  @ApiProperty({ description: 'Whether this is the user default tenant' })
  isDefault!: boolean;

  @ApiProperty({ description: 'Assignment timestamp', format: 'date-time' })
  createdAt!: Date;
}

/**
 * A row of `GET /tenants/:id/users`, and the result of `POST /tenants/:id/users/invite`.
 *
 * `pending` is read straight from `User.kratosIdentityId === null`: an invited email nobody has
 * signed up and verified with yet. The login route (resolveOrProvisionUser) sets that column when the
 * invitee claims the row, so `pending` can't drift from what actually lets someone log in.
 */
export class TenantMemberResponseDto extends TenantUserResponseDto {
  @ApiProperty({ description: 'Invited, but nobody has signed up and verified this email yet' })
  pending!: boolean;
}

/** Result of `GET /tenants/:id/users/lookup` — enough to invite the match, nothing more. */
export class UserLookupResponseDto {
  @ApiProperty({ description: 'User unique identifier', format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'User email' })
  email!: string;

  @ApiProperty({ description: 'User display name' })
  name!: string;

  @ApiProperty({ description: 'Whether this user already belongs to the tenant being queried' })
  isMember!: boolean;
}
