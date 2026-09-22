import { IsString, IsOptional, IsEnum, MinLength, MaxLength, Matches } from 'class-validator';
import { TenantPlan } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTenantDto {
  @ApiProperty({
    description: 'Tenant display name',
    example: 'Acme Corporation',
    minLength: 2,
    maxLength: 100,
  })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    description: 'URL-safe unique identifier (lowercase, alphanumeric, hyphens)',
    example: 'acme-corp',
    pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
  })
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'Slug must be lowercase alphanumeric with hyphens only (e.g., "acme-corp")',
  })
  @MinLength(2)
  @MaxLength(100)
  slug!: string;

  @ApiPropertyOptional({
    description: 'Subscription plan tier',
    enum: TenantPlan,
    default: TenantPlan.FREE,
  })
  @IsOptional()
  @IsEnum(TenantPlan)
  plan?: TenantPlan = TenantPlan.FREE;

  @ApiPropertyOptional({
    description: 'Additional tenant configuration (JSON)',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  config?: Record<string, unknown>;
}
