import { PartialType } from '@nestjs/swagger';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { QuotaPeriod } from '@prisma/client';

export class CreatePlanDto {
  @ApiProperty({ example: 'Gold', minLength: 2, maxLength: 60 })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({ example: '10 rps, 1M requests a month' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    example: 10,
    description: 'Requests allowed per `per` seconds. 0 disables rate limiting (Tyk convention).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  rate?: number;

  @ApiPropertyOptional({ example: 1, description: 'Rate window in seconds.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  per?: number;

  @ApiPropertyOptional({
    example: 1000000,
    description: 'Requests per quota period. **-1 is unlimited** (Tyk convention); 0 allows nothing.',
  })
  @IsOptional()
  @IsInt()
  @Min(-1)
  quotaMax?: number;

  @ApiPropertyOptional({ enum: QuotaPeriod, default: QuotaPeriod.MONTHLY })
  @IsOptional()
  @IsEnum(QuotaPeriod)
  quotaPeriod?: QuotaPeriod;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/**
 * Every field optional. Editing `rate` here is the whole point of plans: it re-pushes ONE policy
 * and every key assigned to this plan picks up the new limit, with no key touched.
 */
export class UpdatePlanDto extends PartialType(CreatePlanDto) {}
