import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  TRAFFIC_METHODS,
  TRAFFIC_STATUS_CLASSES,
  type TrafficStatusClass,
} from '../services/traffic-query.builder';

/**
 * Time window for every analytics read. A closed enum is the only thing that reaches the SQL
 * builders — no free-form interval string is ever accepted.
 */
export enum AnalyticsRange {
  ONE_HOUR = '1h',
  ONE_DAY = '24h',
  SEVEN_DAYS = '7d',
  THIRTY_DAYS = '30d',
}

/** Which series the caller intends to chart. All three are returned regardless (spec §5.4). */
export enum AnalyticsMetric {
  REQUESTS = 'requests',
  ERRORS = 'errors',
  LATENCY = 'latency',
}

export const MAX_TOP_APIS_LIMIT = 50;
/** `/analytics/apis` and `/analytics/keys` return the busiest N rows, never an unbounded array. */
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 50;

export class AnalyticsRangeQueryDto {
  @ApiPropertyOptional({ enum: AnalyticsRange, default: AnalyticsRange.ONE_DAY })
  @IsOptional()
  @IsEnum(AnalyticsRange)
  range: AnalyticsRange = AnalyticsRange.ONE_DAY;
}

export class AnalyticsTimeSeriesQueryDto extends AnalyticsRangeQueryDto {
  @ApiPropertyOptional({ enum: AnalyticsMetric, default: AnalyticsMetric.REQUESTS })
  @IsOptional()
  @IsEnum(AnalyticsMetric)
  metric: AnalyticsMetric = AnalyticsMetric.REQUESTS;
}

export class AnalyticsTopApisQueryDto extends AnalyticsRangeQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_TOP_APIS_LIMIT, default: 10 })
  @IsOptional()
  // A query param arrives as a string. `enableImplicitConversion` cannot help here: an initialiser
  // without a type annotation makes `design:type` Object, so @Type is what coerces "5" -> 5.
  // Without it every `?limit=` value failed @IsInt with a 400.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_TOP_APIS_LIMIT)
  limit = 10;
}

/** `GET /analytics/export?format=csv&range=...`. `format` is closed to `csv` — the only shape shipped. */
export class AnalyticsExportQueryDto extends AnalyticsRangeQueryDto {
  @ApiPropertyOptional({ enum: ['csv'], default: 'csv' })
  @IsOptional()
  @IsIn(['csv'])
  format = 'csv' as const;
}

export class AnalyticsListQueryDto extends AnalyticsRangeQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIST_LIMIT)
  limit = DEFAULT_LIST_LIMIT;
}

/** `GET /analytics/traffic` — every filter is optional and narrows the same window. */
export class AnalyticsTrafficQueryDto extends AnalyticsRangeQueryDto {
  @ApiPropertyOptional({ description: "Only this API (must belong to the caller's tenant)" })
  @IsOptional()
  @IsUUID()
  apiId?: string;

  @ApiPropertyOptional({
    description: "Only requests made with this API key (must belong to the caller's tenant)",
  })
  @IsOptional()
  @IsUUID()
  keyId?: string;

  @ApiPropertyOptional({ enum: TRAFFIC_METHODS })
  @IsOptional()
  @IsIn(TRAFFIC_METHODS)
  method?: (typeof TRAFFIC_METHODS)[number];

  @ApiPropertyOptional({ enum: TRAFFIC_STATUS_CLASSES })
  @IsOptional()
  @IsIn(TRAFFIC_STATUS_CLASSES)
  statusClass?: TrafficStatusClass;

  @ApiPropertyOptional({ minimum: 100, maximum: 599, description: 'An exact status code' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(599)
  status?: number;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Substring of the request path, case-insensitive',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  path?: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 600_000,
    description: 'Only requests at least this slow',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(600_000)
  minLatencyMs?: number;

  @ApiPropertyOptional({ enum: ['authenticated', 'anonymous'] })
  @IsOptional()
  @IsIn(['authenticated', 'anonymous'])
  auth?: 'authenticated' | 'anonymous';
}
