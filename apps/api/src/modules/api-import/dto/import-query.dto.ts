import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Overrides for `POST /apis/import` and `POST /apis/import/preview`. The body is the raw document,
 * so these travel in the query string. Neither value is trusted: the slug is validated again by
 * `CreateApiDto` (shape, length, uniqueness) and the chosen server URL by its SSRF denylist.
 */
export class ImportQueryDto {
  @ApiPropertyOptional({ description: 'Replaces the slug derived from info.title (and so the listen path)', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string;

  @ApiPropertyOptional({ description: 'Which servers[] entry becomes the upstream (default 0)', minimum: 0, maximum: 49 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(49)
  serverIndex?: number;
}
