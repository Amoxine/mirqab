import { PickType } from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';
import { CreateApiDto } from './create-api.dto';

/**
 * `POST /apis/:id/versions` body (WP16). A version is a full API definition in its own right — same
 * `proxyUrl`/`authType`/`config` shape as `CreateApiDto` — reachable through the DEFAULT version's
 * listen path via the `x-api-version` header rather than through a listen path of its own, which is
 * why `slug` and `listenPath` are absent here: `ApiService.createVersion` derives both from the
 * parent so callers never have to invent a second, unused one.
 */
export class CreateApiVersionDto extends PickType(CreateApiDto, ['proxyUrl', 'authType', 'config'] as const) {
  @ApiProperty({
    example: 'v2',
    description: 'Selected via the `x-api-version` header. Unique among this API\'s versions.',
  })
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'Version name must be URL-safe (lowercase letters, numbers, hyphens)',
  })
  versionName!: string;
}
