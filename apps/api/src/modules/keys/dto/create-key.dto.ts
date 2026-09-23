import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsOptional,
  IsUUID,
  IsDateString,
  IsNumber,
  IsInt,
  Min,
  Max,
  IsEnum,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { QuotaPeriod } from '@prisma/client';

export class CreateKeyDto {
  @ApiProperty({
    description: 'Display name for the API key',
    minLength: 1,
    maxLength: 100,
    example: 'Production Mobile App Key',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    description: 'API Definition ID this key is scoped to (optional)',
    format: 'uuid',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @IsOptional()
  @IsUUID()
  apiDefId?: string;

  @ApiPropertyOptional({
    description: 'ISO 8601 expiration date for the key',
    example: '2026-12-31T23:59:59.000Z',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({
    description: 'Maximum number of requests per quota period (0 = unlimited). Requires quotaPeriod.',
    minimum: 0,
    example: 10000,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  quotaLimit?: number;

  @ApiPropertyOptional({
    description: 'Quota reset period',
    enum: QuotaPeriod,
    example: QuotaPeriod.MONTHLY,
  })
  @IsOptional()
  @IsEnum(QuotaPeriod)
  quotaPeriod?: QuotaPeriod;

  @ApiPropertyOptional({
    description: 'Rate limit per second for this key (0 = unlimited)',
    minimum: 0,
    example: 10,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  rateLimitPerSecond?: number;

  @ApiPropertyOptional({
    description:
      'Plan to govern this key (WP18). When set, the key carries `apply_policies` and the plan ' +
      'defines its rate and quota — `rateLimitPerSecond` and `quotaLimit` are then rejected, ' +
      'because an inline limit on the key would override the plan and silently ignore plan edits.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID('4')
  planId?: string;
}
