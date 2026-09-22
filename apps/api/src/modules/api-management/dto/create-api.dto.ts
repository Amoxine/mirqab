import { Type } from 'class-transformer';
import { IsString, IsOptional, IsEnum, IsUrl, MinLength, MaxLength, Matches, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiAuthType } from '@prisma/client';
import { ApiConfigDto } from './api-config.dto';
import { IsAllowedProxyUrl } from './proxy-url.validator';

export class CreateApiDto {
  @ApiProperty({ example: 'My API', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 'my-api', description: 'URL-safe slug, unique per tenant' })
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'Slug must be URL-safe (lowercase letters, numbers, hyphens)',
  })
  slug!: string;

  @ApiProperty({
    example: 'https://backend.example.com/api',
    description:
      'Upstream URL. Internal service names and RFC1918 addresses are allowed; loopback, ' +
      'link-local / cloud metadata and the platform\'s own services are refused (see PROXY_DENY_HOSTS).',
  })
  // require_tld: false — upstreams are often internal service names (http://orders:8080, k8s svc).
  // Not the platform's OWN service names, though: those are denied, see proxy-url.validator.ts.
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  @IsAllowedProxyUrl()
  proxyUrl!: string;

  // Unique within the tenant, not globally (O10). What reaches the gateway is
  // `/{tenant.slug}{listenPath}`, and tenant slugs are globally unique, so two tenants can both own
  // `/payments/` without sharing a route. Global uniqueness used to be the defence against that
  // collision; it also let whichever tenant asked first squat a path for everyone, which is why it
  // is gone. Compared as the exact string — prefix overlaps like /a/ and /a/b/ coexist and Tyk
  // routes them by longest match.
  @ApiProperty({ example: '/my-api/', description: 'Listen path for the API, unique within your tenant' })
  @IsString()
  @MinLength(1)
  @Matches(/^\//, { message: 'Listen path must start with /' })
  listenPath!: string;

  // No initializer: UpdateApiDto (PartialType) would inherit it and reset authType to NONE on every PATCH.
  // The default (NONE) comes from the Prisma schema.
  @ApiPropertyOptional({ enum: ApiAuthType, default: ApiAuthType.NONE })
  @IsOptional()
  @IsEnum(ApiAuthType)
  authType?: ApiAuthType;

  @ApiPropertyOptional({
    description: 'Per-API configuration: rate limit, CORS, do-not-track',
    type: ApiConfigDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApiConfigDto)
  config?: ApiConfigDto;
}
