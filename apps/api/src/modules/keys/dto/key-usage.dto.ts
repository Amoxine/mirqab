import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export const KEY_USAGE_RANGES = ['1h', '24h', '7d', '30d'] as const;
export type KeyUsageRange = (typeof KEY_USAGE_RANGES)[number];

export class KeyUsageQueryDto {
  @ApiPropertyOptional({ enum: KEY_USAGE_RANGES, default: '24h' })
  @IsOptional()
  @IsIn(KEY_USAGE_RANGES)
  range?: KeyUsageRange;
}

export class KeyUsageDto {
  @ApiProperty({ enum: KEY_USAGE_RANGES })
  range!: KeyUsageRange;

  @ApiProperty({ description: 'Requests made with this key in the range' })
  requests!: number;

  @ApiProperty({ description: 'Non-2xx responses in the range' })
  errors!: number;

  @ApiProperty({ description: 'errors / requests as a percentage (0-100); 0 without traffic' })
  errorRate!: number;

  @ApiProperty({ description: 'Mean gateway latency in ms; 0 without traffic' })
  avgLatencyMs!: number;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Live quota ceiling from the gateway; null when the key has no quota or the gateway is unreachable',
  })
  quotaMax!: number | null;

  @ApiProperty({ nullable: true, type: Number, description: 'Live requests left in the current quota window' })
  quotaRemaining!: number | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time', description: 'When the quota window renews' })
  quotaResetAt!: Date | null;
}

export class KeyUsageResponseDto {
  @ApiProperty({ type: KeyUsageDto })
  data!: KeyUsageDto;
}
