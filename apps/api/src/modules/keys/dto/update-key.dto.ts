import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsOptional,
  IsDateString,
  IsNumber,
  IsInt,
  Min,
  Max,
  IsEnum,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { QuotaPeriod } from '@prisma/client';

// A PATCH field is either absent or valid. `@IsOptional()` would also let an explicit `null` through.
const whenSent = (_dto: unknown, value: unknown): boolean => value !== undefined;

export class UpdateKeyDto {
  @ApiPropertyOptional({ description: 'Display name for the API key', maxLength: 100 })
  @ValidateIf(whenSent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: 'Rate limit per second for this key (0 = unlimited)',
    minimum: 0,
    example: 25,
  })
  @ValidateIf(whenSent)
  @IsNumber()
  @Min(0)
  rateLimitPerSecond?: number;

  @ApiPropertyOptional({
    description:
      'Maximum number of requests per quota period (0 = remove the quota). Changing the quota resets consumption.',
    minimum: 0,
    example: 500,
  })
  @ValidateIf(whenSent)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  quotaLimit?: number;

  @ApiPropertyOptional({ description: 'Quota reset period', enum: QuotaPeriod, example: QuotaPeriod.HOURLY })
  @ValidateIf(whenSent)
  @IsEnum(QuotaPeriod)
  quotaPeriod?: QuotaPeriod;

  @ApiPropertyOptional({
    description: 'ISO 8601 expiration date for the key; null removes the expiry',
    nullable: true,
    example: '2026-12-31T23:59:59.000Z',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;
}
