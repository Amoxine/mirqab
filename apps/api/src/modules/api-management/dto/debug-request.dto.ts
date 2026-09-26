import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUrl, Matches, MaxLength, ValidateBy } from 'class-validator';
import { HEADER_NAME, HEADER_VALUE, ITEM_MAX, LIST_MAX } from './api-config.dto';
import { IsAllowedProxyUrl } from './proxy-url.validator';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/**
 * Why a `headers` map is unacceptable, or null. Same rules as `ApiHeaderDto`. Checked here because
 * anything else reaches Tyk's /debug and comes back as an opaque 400 "Request malformed".
 */
function headerMapProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return 'headers must be an object';
  const entries = Object.entries(value);
  if (entries.length > LIST_MAX)
    return `headers must not have more than ${String(LIST_MAX)} entries`;
  for (const [name, v] of entries) {
    if (name.length > ITEM_MAX || !HEADER_NAME.test(name))
      return `header name "${name.slice(0, 40)}" is not an RFC 7230 token`;
    if (typeof v !== 'string') return `header "${name}" must have a string value`;
    if (v.length > ITEM_MAX)
      return `header "${name}" value is longer than ${String(ITEM_MAX)} characters`;
    if (!HEADER_VALUE.test(v)) return `header "${name}" value must not contain CR, LF or NUL`;
  }
  return null;
}

/**
 * A sample request to run against an API's own definition, for the Designer's "Test request".
 *
 * The DEFINITION is built server-side from the stored row — the caller cannot supply one. That is
 * the main reason this endpoint is not an SSRF hole: the upstream is whatever the API is already
 * configured to proxy to, which passed `IsAllowedProxyUrl` when the API was created.
 *
 * `targetUrl` is the one exception, and it exists because testing against a staging upstream
 * without editing the live API is the obvious thing to want. It therefore carries the SAME
 * validator the API's own `proxyUrl` does — `proxy-url.validator.ts`, reused rather than
 * reimplemented, so a host added to the deny list is denied here the same day and in one place.
 */
export class DebugRequestDto {
  @ApiProperty({ enum: METHODS })
  @IsIn(METHODS)
  method!: (typeof METHODS)[number];

  @ApiProperty({ example: '/users/42', description: 'Path as the caller would send it, after the listen path' })
  @IsString()
  @MaxLength(2048)
  @Matches(/^\//, { message: 'path must start with /' })
  path!: string;

  @ApiPropertyOptional({ type: Object, example: { 'X-Trace': 'abc' } })
  @IsOptional()
  @ValidateBy({
    name: 'isHeaderMap',
    validator: {
      validate: (value: unknown) => headerMapProblem(value) === null,
      defaultMessage: (args) => headerMapProblem(args?.value) ?? 'headers is invalid',
    },
  })
  headers?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Request body, sent verbatim' })
  @IsOptional()
  @IsString()
  @MaxLength(64_000)
  body?: string;

  @ApiPropertyOptional({
    example: 'https://staging.orders.internal:4000',
    description:
      "Override the upstream for this test only. Validated by the same SSRF deny list as the API's " +
      'own proxyUrl; a denied host is rejected with 400 and nothing is sent.',
  })
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  @IsAllowedProxyUrl()
  targetUrl?: string;
}
