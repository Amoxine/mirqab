import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiMockDto, EDGE_BODY_LIMIT_BYTES, Raw } from './api-config.dto';
import { ENDPOINT_CONTROL_NAMES, type EndpointControlName } from '../services/endpoint-governance';

// main.ts runs ValidationPipe with forbidNonWhitelisted: an unknown field or control is a 400.

/** An endpoint key is `operationId` or `METHOD /path[ #n]`; long paths exist, unbounded ones do not. */
const KEY_MAX = 2048;

export class EndpointRateLimitDto {
  @ApiProperty({ minimum: 1, maximum: 1_000_000_000 })
  @Raw()
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  rate!: number;

  @ApiProperty({ minimum: 1, maximum: 86_400, description: 'Window in seconds' })
  @Raw()
  @IsInt()
  @Min(1)
  @Max(86_400)
  per!: number;
}

export class EndpointCacheDto {
  @ApiProperty({ minimum: 1, maximum: 86_400 })
  @Raw()
  @IsInt()
  @Min(1)
  @Max(86_400)
  timeoutSeconds!: number;

  @ApiPropertyOptional({ type: [Number], example: [200] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  @Min(100, { each: true })
  @Max(599, { each: true })
  cacheResponseCodes?: number[];
}

/** One `set`: every control optional; `enabled: true` and `auth: 'inherit'` clear the control. */
export class EndpointGovernanceInputDto {
  @ApiPropertyOptional({ description: 'false blocks the endpoint (403); true clears the block' })
  @IsOptional()
  @Raw()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ enum: ['public', 'inherit'], description: '"public" answers without credentials' })
  @IsOptional()
  @IsIn(['public', 'inherit'])
  auth?: 'public' | 'inherit';

  @ApiPropertyOptional({ type: EndpointRateLimitDto, description: 'ONE counter shared by all consumers' })
  @IsOptional()
  @ValidateNested()
  @Type(() => EndpointRateLimitDto)
  rateLimit?: EndpointRateLimitDto;

  @ApiPropertyOptional({ type: EndpointCacheDto, description: 'GET only' })
  @IsOptional()
  @ValidateNested()
  @Type(() => EndpointCacheDto)
  cache?: EndpointCacheDto;

  @ApiPropertyOptional({ minimum: 1, maximum: 600 })
  @IsOptional()
  @Raw()
  @IsInt()
  @Min(1)
  @Max(600)
  timeoutSeconds?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: EDGE_BODY_LIMIT_BYTES })
  @IsOptional()
  @Raw()
  @IsInt()
  @Min(1)
  @Max(EDGE_BODY_LIMIT_BYTES)
  requestSizeLimitBytes?: number;

  @ApiPropertyOptional({ type: ApiMockDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiMockDto)
  mock?: ApiMockDto;

  @ApiPropertyOptional({ description: 'Inline JSON Schema (no $ref, <= 64 KB); POST/PUT/PATCH only' })
  @IsOptional()
  @IsObject()
  validateRequestSchema?: Record<string, unknown>;
}

export class UpdateEndpointsDto {
  @ApiProperty({ description: 'The `revision` from the last GET; a stale one answers 409' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: 'expectedRevision must be 64 lower-case hex characters' })
  expectedRevision!: string;

  @ApiPropertyOptional({ type: [String], description: 'Endpoint keys from the latest spec index' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(KEY_MAX, { each: true })
  keys?: string[];

  @ApiPropertyOptional({ description: 'Every endpoint carrying this tag' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  tag?: string;

  @ApiPropertyOptional({ type: EndpointGovernanceInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => EndpointGovernanceInputDto)
  set?: EndpointGovernanceInputDto;

  @ApiPropertyOptional({ enum: ENDPOINT_CONTROL_NAMES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ENDPOINT_CONTROL_NAMES.length)
  @IsIn(ENDPOINT_CONTROL_NAMES, { each: true })
  clear?: EndpointControlName[];

  @ApiPropertyOptional({ description: 'Allow-list mode: every path and method not in the spec answers 403' })
  @IsOptional()
  @Raw()
  @IsBoolean()
  restrictToSpec?: boolean;

  @ApiPropertyOptional({ description: 'Remove stored governance whose key is no longer in the spec' })
  @IsOptional()
  @Raw()
  @IsBoolean()
  dropOrphans?: boolean;
}
