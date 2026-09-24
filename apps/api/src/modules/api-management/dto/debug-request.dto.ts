import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, IsUrl, Matches, MaxLength } from 'class-validator';
import { IsAllowedProxyUrl } from './proxy-url.validator';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

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
  @IsObject()
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
