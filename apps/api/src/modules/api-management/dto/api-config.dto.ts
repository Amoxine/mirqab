import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsAllowedProxyUrl } from './proxy-url.validator';

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


/**
 * Largest per-API request body this product will accept, in bytes.
 *
 * It is the EDGE's limit, not an independent choice: `infra/edge/Caddyfile` sets Coraza's
 * `SecRequestBodyLimit` / `SecRequestBodyNoFilesLimit` to 10485760 (WP26b). Two enforcers now sit in
 * front of an upstream and the SMALLER one answers, so capping the per-API limit here at the edge's
 * value keeps the gateway the smaller enforcer for every API — which is what makes an oversize body
 * reliably produce Tyk's 413 rather than Coraza's, and makes the response attributable.
 *
 * `edge-body-limit.spec.ts` parses the Caddyfile and fails if these two ever diverge; without that
 * the drift is silent and the 413 quietly changes which component answers it.
 */
export const EDGE_BODY_LIMIT_BYTES = 10_485_760;

export class ApiThrottleDto {
  @ApiProperty({ minimum: 0, description: 'Queued retries allowed once the rate limit is hit. 0 disables throttling.' })
  @Raw()
  @IsInt()
  @Min(0)
  @Max(1000)
  retryLimit!: number;

  @ApiProperty({ minimum: 1, description: 'Seconds between queued retries' })
  @Raw()
  @IsInt()
  @Min(1)
  @Max(3600)
  intervalSeconds!: number;
}

export class ApiCircuitBreakerDto {
  @ApiProperty({ minimum: 0, maximum: 1, description: 'Error rate (0-1) that trips the breaker' })
  @Raw()
  @IsNumber()
  @Min(0)
  @Max(1)
  threshold!: number;

  @ApiProperty({ minimum: 1, description: 'Requests sampled before the threshold is evaluated' })
  @Raw()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  sampleSize!: number;

  @ApiProperty({ minimum: 1, description: 'Seconds the breaker stays open before a trial request' })
  @Raw()
  @IsInt()
  @Min(1)
  @Max(86_400)
  coolDownSeconds!: number;
}

export class ApiLoadBalancingTargetDto {
  @ApiProperty({ example: 'http://orders-b:4000' })
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  @IsAllowedProxyUrl()
  url!: string;

  @ApiProperty({ minimum: 1, description: 'Relative share of traffic' })
  @Raw()
  @IsInt()
  @Min(1)
  @Max(1000)
  weight!: number;
}

export class ApiLoadBalancingDto {
  @ApiProperty({ type: [ApiLoadBalancingTargetDto] })
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @ValidateNested({ each: true })
  @Type(() => ApiLoadBalancingTargetDto)
  targets!: ApiLoadBalancingTargetDto[];

  @ApiPropertyOptional({ description: 'Skip targets the uptime test has marked down' })
  @IsOptional()
  @Raw()
  @IsBoolean()
  skipUnavailableHosts?: boolean;
}

export class ApiUptimeTestDto {
  @ApiProperty({ description: 'Absolute URL the gateway probes' })
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  @IsAllowedProxyUrl()
  url!: string;

  @ApiPropertyOptional({ default: 'GET' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  method?: string;

  @ApiPropertyOptional({ minimum: 1, description: 'Probe timeout in seconds' })
  @IsOptional()
  @Raw()
  @IsInt()
  @Min(1)
  @Max(300)
  timeoutSeconds?: number;
}


export class ApiHeaderDto {
  @ApiProperty({ example: 'X-Request-Source' })
  @IsString()
  @MaxLength(ITEM_MAX)
  name!: string;

  @ApiProperty({ example: 'open-gateway' })
  @IsString()
  @MaxLength(ITEM_MAX)
  value!: string;
}

/** Headers added to / removed from a request or response. Both directions use this shape. */
export class ApiTransformHeadersDto {
  @ApiPropertyOptional({ type: [ApiHeaderDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @ValidateNested({ each: true })
  @Type(() => ApiHeaderDto)
  add?: ApiHeaderDto[];

  @ApiPropertyOptional({ type: [String], example: ['X-Internal-Token'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  @MaxLength(ITEM_MAX, { each: true })
  remove?: string[];
}

export class ApiUrlRewriteDto {
  @ApiProperty({ example: '/old/(.*)', description: 'Regex matched against the stripped path' })
  @IsString()
  @MaxLength(ITEM_MAX)
  pattern!: string;

  @ApiProperty({ example: '/new/$1' })
  @IsString()
  @MaxLength(ITEM_MAX)
  rewriteTo!: string;
}

/** Short-circuits the request: the upstream is never called. */
export class ApiMockDto {
  @ApiProperty({ minimum: 100, maximum: 599, example: 200 })
  @Raw()
  @IsInt()
  @Min(100)
  @Max(599)
  code!: number;

  @ApiProperty({ example: '{"status":"ok"}' })
  @IsString()
  @MaxLength(64_000)
  body!: string;

  @ApiPropertyOptional({ type: [ApiHeaderDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @ValidateNested({ each: true })
  @Type(() => ApiHeaderDto)
  headers?: ApiHeaderDto[];
}

export class ApiBodyTransformDto {
  @ApiProperty({ enum: ['json', 'xml'] })
  @IsIn(['json', 'xml'])
  format!: 'json' | 'xml';

  @ApiProperty({ description: 'Go template applied to the body' })
  @IsString()
  @MaxLength(64_000)
  body!: string;
}

export class ApiCacheDto {
  @ApiProperty({ minimum: 1, description: 'Seconds a cached response is served for' })
  @Raw()
  @IsInt()
  @Min(1)
  @Max(86_400)
  timeoutSeconds!: number;

  @ApiPropertyOptional({ description: 'Cache every safe (GET/HEAD/OPTIONS) request' })
  @IsOptional()
  @Raw()
  @IsBoolean()
  cacheAllSafeRequests?: boolean;

  @ApiPropertyOptional({ type: [Number], example: [200], description: 'Response codes worth caching' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  cacheResponseCodes?: number[];
}


/**
 * IP allow / deny, evaluated by the gateway against the CLIENT ip.
 *
 * Only meaningful because the edge REPLACES `X-Forwarded-For` with the real peer rather than
 * appending to it (infra/edge/Caddyfile) and the gateway reads the last entry (`xff_depth: 1`).
 * Without both, a caller could name an allowed IP in the header and walk straight through — which
 * is what `wp15c-acceptance.ts` asserts cannot happen.
 */
export class ApiIpAccessControlDto {
  @ApiPropertyOptional({ type: [String], example: ['10.0.0.0/8'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  @MaxLength(ITEM_MAX, { each: true })
  allow?: string[];

  @ApiPropertyOptional({ type: [String], example: ['203.0.113.7'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LIST_MAX)
  @IsString({ each: true })
  @MaxLength(ITEM_MAX, { each: true })
  block?: string[];
}

export class ApiHmacDto {
  @ApiPropertyOptional({ type: [String], example: ['hmac-sha256'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  allowedAlgorithms?: string[];

  @ApiPropertyOptional({ minimum: 0, description: 'Permitted clock skew in ms; 0 disables the check' })
  @IsOptional()
  @Raw()
  @IsInt()
  @Min(0)
  @Max(600_000)
  allowedClockSkewMs?: number;
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

  @ApiPropertyOptional({ type: ApiThrottleDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiThrottleDto)
  throttle?: ApiThrottleDto | null;

  @ApiPropertyOptional({ minimum: 1, description: 'Upstream timeout in seconds; the gateway answers 504 past it' })
  @IsOptional()
  @Raw()
  @IsInt()
  @Min(1)
  @Max(600)
  timeoutSeconds?: number | null;

  @ApiPropertyOptional({ type: ApiCircuitBreakerDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiCircuitBreakerDto)
  circuitBreaker?: ApiCircuitBreakerDto | null;

  @ApiPropertyOptional({
    maximum: EDGE_BODY_LIMIT_BYTES,
    description: `Largest accepted request body in bytes. Capped at ${String(EDGE_BODY_LIMIT_BYTES)} (the edge's own limit) so the gateway is always the smaller enforcer and the 413 is attributable to it.`,
  })
  @IsOptional()
  @Raw()
  @IsInt()
  @Min(1)
  // A value above the edge's limit is REJECTED rather than clamped: silently shrinking what the
  // operator asked for would make `GET /apis/:id` disagree with what they wrote.
  @Max(EDGE_BODY_LIMIT_BYTES)
  requestSizeLimitBytes?: number | null;

  @ApiPropertyOptional({ type: ApiLoadBalancingDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiLoadBalancingDto)
  loadBalancing?: ApiLoadBalancingDto | null;

  @ApiPropertyOptional({ type: [ApiUptimeTestDto], nullable: true, description: 'Probes that compute healthStatus' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ApiUptimeTestDto)
  uptimeTests?: ApiUptimeTestDto[] | null;

  @ApiPropertyOptional({ type: ApiTransformHeadersDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiTransformHeadersDto)
  transformRequestHeaders?: ApiTransformHeadersDto | null;

  @ApiPropertyOptional({ type: ApiTransformHeadersDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiTransformHeadersDto)
  transformResponseHeaders?: ApiTransformHeadersDto | null;

  @ApiPropertyOptional({ type: ApiUrlRewriteDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiUrlRewriteDto)
  urlRewrite?: ApiUrlRewriteDto | null;

  @ApiPropertyOptional({ type: ApiMockDto, nullable: true, description: 'When set, the upstream is never called' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiMockDto)
  mock?: ApiMockDto | null;

  @ApiPropertyOptional({ type: ApiBodyTransformDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiBodyTransformDto)
  transformRequestBody?: ApiBodyTransformDto | null;

  @ApiPropertyOptional({ type: ApiBodyTransformDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiBodyTransformDto)
  transformResponseBody?: ApiBodyTransformDto | null;

  @ApiPropertyOptional({ type: ApiCacheDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiCacheDto)
  cache?: ApiCacheDto | null;

  @ApiPropertyOptional({ type: ApiIpAccessControlDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiIpAccessControlDto)
  ipAccessControl?: ApiIpAccessControlDto | null;

  @ApiPropertyOptional({
    description:
      'JSON Schema the request body must satisfy. A violation is rejected by the GATEWAY with 422, ' +
      'so a malformed body never reaches the upstream.',
  })
  @IsOptional()
  @IsObject()
  validateRequestSchema?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    example: 'X-Api-Key',
    description:
      'Header the API key is read from. Defaults to Authorization. Setting it REPLACES that header ' +
      'rather than adding an alternative — a key sent in Authorization is then rejected.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9-]+$/, { message: 'authHeaderName may only contain letters, digits and hyphens' })
  authHeaderName?: string;

  @ApiPropertyOptional({ type: ApiHmacDto, nullable: true, description: 'Only read when authType is HMAC' })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiHmacDto)
  hmac?: ApiHmacDto | null;


  @ApiPropertyOptional({
    description:
      'Record full request/response detail for THIS api. Off by default and per-API on purpose (O9): ' +
      'the global default stays false because detailed records carry headers and bodies.',
  })
  @IsOptional()
  @Raw()
  @IsBoolean()
  detailedRecording?: boolean;
}



/** Data-only view of `ApiConfigDto` (no class identity): the shape stored in `ApiDefinition.config`. */
export type ApiConfig = Pick<ApiConfigDto, keyof ApiConfigDto>;
