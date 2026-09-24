import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiKeyStatus } from '@prisma/client';

/** Response of `POST /keys`. `keyValue` is the raw key — returned ONCE, never stored or logged. */
export class KeyResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ApiKeyStatus })
  status!: ApiKeyStatus;

  @ApiPropertyOptional({ format: 'date-time' })
  expiresAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiPropertyOptional({
    description: 'Raw key value — shown ONLY on creation, never again',
  })
  keyValue?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  apiDefId?: string | null;

  @ApiPropertyOptional({ format: 'uuid', description: 'WP19: null is a valid, fully-functional state' })
  planId?: string | null;
}

export class KeyListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ApiKeyStatus })
  status!: ApiKeyStatus;

  @ApiPropertyOptional({ format: 'date-time' })
  expiresAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiPropertyOptional({ format: 'uuid' })
  apiDefId!: string | null;

  @ApiPropertyOptional()
  apiDefName!: string | null;

  @ApiPropertyOptional({ format: 'uuid', description: 'WP19: null is a valid, fully-functional state' })
  planId!: string | null;

  @ApiPropertyOptional()
  planName!: string | null;
}

export class KeyListResponseDto {
  @ApiProperty({ type: [KeyListItemDto] })
  data!: KeyListItemDto[];

  @ApiProperty()
  meta!: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
}

/** Live limits as enforced by the gateway (`GET /tyk/keys/{hash}`). */
export class KeyTykStateDto {
  @ApiProperty({ description: 'Requests allowed per `per` seconds; 0 = unlimited' })
  rate!: number;

  @ApiProperty({ description: 'Rate-limit window in seconds' })
  per!: number;

  @ApiProperty({ description: 'Quota ceiling per renewal period; 0 or less = unlimited' })
  quotaMax!: number;

  @ApiProperty({ description: 'Requests left in the current quota window' })
  quotaRemaining!: number;

  @ApiProperty({ description: 'Quota renewal period in seconds' })
  quotaRenewalRate!: number;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  quotaRenewsAt!: Date | null;
}

export class KeyDetailResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ApiKeyStatus })
  status!: ApiKeyStatus;

  @ApiPropertyOptional({ format: 'date-time' })
  expiresAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiPropertyOptional({ format: 'uuid' })
  apiDefId!: string | null;

  @ApiPropertyOptional()
  apiDefName!: string | null;

  @ApiPropertyOptional({ format: 'uuid', description: 'WP19: null is a valid, fully-functional state' })
  planId!: string | null;

  @ApiPropertyOptional()
  planName!: string | null;

  @ApiProperty({
    type: KeyTykStateDto,
    nullable: true,
    description: 'Live gateway state; null when the gateway is unreachable or the key is no longer active',
  })
  tyk!: KeyTykStateDto | null;
}
