import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ImportQueryDto } from './import-query.dto';
import { SPEC_SOURCE_INTERVALS, type SpecSourceInterval } from '../services/spec-source.service';

/**
 * The RAW body value: the global pipe's implicit conversion turns any non-empty string into `true`
 * (`Boolean('false')`), so `"false"` would ENABLE a source. Anything but a JSON boolean fails IsBoolean.
 */
const StrictBoolean = (): PropertyDecorator =>
  Transform(({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key]);

const URL_DOC = 'http(s) URL of the OpenAPI document, ≤ 2048 characters, no userinfo (a secret in the query string is supported and never shown back)';

/** `PUT /apis/:id/spec-source` (OAS-08). The fetcher's policy (resolve-time, allow-list) checks `url` too. */
export class PutSpecSourceDto {
  @ApiPropertyOptional({ description: `${URL_DOC}. Omit on an edit to keep the stored one.`, maxLength: 2048 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  url?: string;

  @ApiProperty({ enum: SPEC_SOURCE_INTERVALS, description: 'Minutes between checks' })
  @IsIn(SPEC_SOURCE_INTERVALS)
  intervalMinutes!: SpecSourceInterval;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @StrictBoolean()
  @IsBoolean()
  enabled?: boolean;
}

/** `POST /apis/import/url/preview`: the import overrides plus the URL, as a JSON body. */
export class ImportUrlPreviewDto extends ImportQueryDto {
  @ApiProperty({ description: URL_DOC, maxLength: 2048 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  url!: string;
}

/** `POST /apis/import/url`: `watch: true` also keeps checking the URL for changes. */
export class ImportUrlDto extends ImportUrlPreviewDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @StrictBoolean()
  @IsBoolean()
  watch?: boolean;

  @ApiPropertyOptional({ enum: SPEC_SOURCE_INTERVALS, default: 60 })
  @IsOptional()
  @IsIn(SPEC_SOURCE_INTERVALS)
  intervalMinutes?: SpecSourceInterval;
}
