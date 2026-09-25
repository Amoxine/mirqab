import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Reads the RAW query value: the global pipe's implicit conversion would turn the string "false"
 * into `true` (`Boolean('false')`). Anything but `true`/`false` stays a string and fails `IsBoolean`.
 */
const QueryBoolean = (): PropertyDecorator =>
  Transform(({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
    const raw = obj[key];
    return raw === 'true' || raw === true ? true : raw === 'false' || raw === false ? false : raw;
  });

/** Query of `POST /apis/:id/spec/preview` (OAS-04). The body is the raw document, like the import. */
export class SpecPreviewQueryDto {
  @ApiProperty({
    description: 'The latest versionNo the caller has seen, 0 when the API has no stored spec (compare-and-set); stale → 409 SPEC_VERSION_STALE',
    minimum: 0,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  expectedVersion!: number;
}

/** Query of `POST /apis/:id/spec` (OAS-04): the audited apply. There is no dry-run flag: that is the preview route. */
export class SpecUpdateQueryDto extends SpecPreviewQueryDto {
  @ApiPropertyOptional({ description: 'Apply even though governed endpoints are removed (their settings become orphans)', default: false })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  acknowledgeRemoved?: boolean;
}
