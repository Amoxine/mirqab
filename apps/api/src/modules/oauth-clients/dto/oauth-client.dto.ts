import { IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { QuotaPeriod } from '@prisma/client';

export class CreateOAuthClientDto {
  @ApiProperty({
    description: 'Display name for the OAuth2 client',
    minLength: 1,
    maxLength: 100,
    example: 'Partner billing service',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    description: 'API definition the client is scoped to. Must use authType OAUTH and be synced.',
    format: 'uuid',
  })
  @IsUUID()
  apiDefId!: string;

  @ApiPropertyOptional({
    description: 'Requests per second for this client (0 / omitted = unlimited)',
    minimum: 0,
    example: 10,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  rateLimitPerSecond?: number;

  @ApiPropertyOptional({
    description: 'Maximum requests per quota period (0 / omitted = unlimited). Requires quotaPeriod.',
    minimum: 0,
    example: 10000,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  quotaLimit?: number;

  @ApiPropertyOptional({ description: 'Quota reset period', enum: QuotaPeriod })
  @IsOptional()
  @IsEnum(QuotaPeriod)
  quotaPeriod?: QuotaPeriod;
}

export class OAuthClientDto {
  @ApiProperty({ description: 'Hydra OAuth2 client id, used as the `client_id` credential' })
  clientId!: string;

  @ApiProperty({ description: 'Display name' })
  name!: string;

  @ApiProperty({ description: 'API definition this client may call' })
  apiDefId!: string;

  @ApiProperty({ description: 'ISO 8601 creation timestamp', nullable: true })
  createdAt!: string | null;
}

export class OAuthClientSecretDto extends OAuthClientDto {
  @ApiProperty({ description: 'Raw client secret — returned ONCE, on create and on rotate' })
  clientSecret!: string;

  @ApiProperty({ description: 'OAuth2 token endpoint for the client_credentials exchange' })
  tokenUrl!: string;
}

export class OAuthClientListDto {
  @ApiProperty({ type: [OAuthClientDto] })
  data!: OAuthClientDto[];
}
