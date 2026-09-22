import { IsString, IsOptional, IsEnum, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TenantStatus, TenantPlan } from '@prisma/client';

export class UpdateTenantDto {
  @ApiPropertyOptional({
    description: 'Tenant display name',
    example: 'Acme Corporation Ltd',
    minLength: 2,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: 'URL-safe unique slug (lowercase, alphanumeric, hyphens)',
    example: 'acme-corp-updated',
    pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'Slug must be lowercase alphanumeric with hyphens only',
  })
  @MinLength(2)
  @MaxLength(100)
  slug?: string;

  @ApiPropertyOptional({
    description: 'Tenant status',
    enum: TenantStatus,
  })
  @IsOptional()
  @IsEnum(TenantStatus)
  status?: TenantStatus;

  @ApiPropertyOptional({
    description: 'Subscription plan tier',
    enum: TenantPlan,
  })
  @IsOptional()
  @IsEnum(TenantPlan)
  plan?: TenantPlan;

  @ApiPropertyOptional({
    description: 'Additional tenant configuration (JSON)',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  config?: Record<string, unknown>;
}
