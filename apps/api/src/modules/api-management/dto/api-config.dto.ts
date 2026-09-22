import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// main.ts runs ValidationPipe with forbidNonWhitelisted: every accepted field must be decorated here.

const LIST_MAX = 50;
const ITEM_MAX = 255;

/**
 * The global ValidationPipe uses enableImplicitConversion, which would turn "false" into true and
 * "" into 0 before validation. Keep the raw JSON value so the type validators see what the client sent.
 */
const Raw = (): PropertyDecorator =>
  Transform(({ obj, key }: TransformFnParams) => (obj as Record<string, unknown>)[key]);

export class ApiRateLimitDto {
  @ApiProperty({ minimum: 0, description: 'Requests allowed per `per` seconds. 0 disables the limit.' })
  @Raw()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  rate!: number;

  @ApiProperty({ minimum: 1, description: 'Window length in seconds' })
  @Raw()
  @IsInt()
  @Min(1)
  @Max(31_536_000)
  per!: number;
}

export class ApiCorsDto {
  @ApiProperty()
  @Raw()
  @IsBoolean()
  enable!: boolean;

  @ApiProperty({ type: [String], example: ['http://localhost:33000'] })
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  @MaxLength(ITEM_MAX, { each: true })
  allowedOrigins!: string[];

  @ApiProperty({ type: [String], example: ['GET', 'POST'] })
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  @MaxLength(ITEM_MAX, { each: true })
  allowedMethods!: string[];

  @ApiProperty({ type: [String], example: ['Authorization'] })
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  @MaxLength(ITEM_MAX, { each: true })
  allowedHeaders!: string[];

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  @MaxLength(ITEM_MAX, { each: true })
  exposedHeaders!: string[];

  @ApiProperty()
  @Raw()
  @IsBoolean()
  allowCredentials!: boolean;

  @ApiProperty({ minimum: 0, description: 'Preflight cache lifetime in seconds' })
  @Raw()
  @IsInt()
  @Min(0)
  @Max(31_536_000)
  maxAge!: number;
}

/**
 * Bring-your-own JWKS config for `authType: JWT` (O3). Required once that authType is set — see
 * `ApiService.create`/`update`, which reject `authType: JWT` with no `jwt` section rather than
 * silently emitting an API that rejects every request the way the old unconditional `enable_jwt`
 * did (`mapToTykFormat`'s ponytail comment explains why a token from elsewhere never validates).
 */
export class ApiJwtDto {
  @ApiProperty({
    example: 'https://idp.example.com/.well-known/jwks.json',
    description: "The token issuer's JWKS endpoint. Only a token signed by a key in this set validates.",
  })
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  jwksUrl!: string;

  @ApiProperty({
    example: 'https://idp.example.com/',
    description:
      'Recorded for reference/audit only — Tyk classic API definitions have no `iss`-claim check of ' +
      'their own; "wrong issuer" is rejected because that token is not signed by a key in jwksUrl.',
  })
  @IsString()
  @MaxLength(255)
  issuer!: string;

  @ApiPropertyOptional({ default: 'sub', description: 'JWT claim Tyk reads as the caller identity' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  identityField?: string;
}

/** `ApiDefinition.config` JSON (spec §3.2). `null` on a section clears it; an absent section is left as-is. */
export class ApiConfigDto {
  @ApiPropertyOptional({ type: ApiRateLimitDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiRateLimitDto)
  rateLimit?: ApiRateLimitDto | null;

  @ApiPropertyOptional({ type: ApiCorsDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiCorsDto)
  cors?: ApiCorsDto | null;

  @ApiPropertyOptional({ description: 'Disable analytics recording for this API' })
  @IsOptional()
  @Raw()
  @IsBoolean()
  doNotTrack?: boolean;

  @ApiPropertyOptional({ type: ApiJwtDto, nullable: true, description: 'Required when authType is JWT' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiJwtDto)
  jwt?: ApiJwtDto | null;
}

/** Data-only view of `ApiConfigDto` (no class identity): the shape stored in `ApiDefinition.config`. */
export type ApiConfig = Pick<ApiConfigDto, keyof ApiConfigDto>;
