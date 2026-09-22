import { IsOptional, IsISO8601, IsString, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { PaginationDto } from '../../tenants/dto/pagination.dto';

/**
 * A UI that always appends its filter state sends `?dateFrom=` to mean "no filter", and
 * `@IsOptional()` only skips null/undefined — an empty string would fail validation with a 400.
 */
const BlankToUndefined = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (value === '' ? undefined : value));

/**
 * Extends the shared PaginationDto so `page` (>= 1) and `pageSize` (1..100) are validated: the bare
 * `ParseIntPipe` this replaced accepted `page=0` (negative skip -> Prisma 500) and any pageSize.
 */
export class AuditQueryDto extends PaginationDto {
  @ApiPropertyOptional({ example: '2026-01-01', description: 'Inclusive lower bound (YYYY-MM-DD)' })
  @IsOptional()
  @BlankToUndefined()
  @IsISO8601()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-01-31', description: 'Inclusive upper bound (YYYY-MM-DD)' })
  @IsOptional()
  @BlankToUndefined()
  @IsISO8601()
  dateTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @BlankToUndefined()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ description: 'AuditAction value; anything else is ignored' })
  @IsOptional()
  @BlankToUndefined()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ description: 'Substring match on the resource' })
  @IsOptional()
  @BlankToUndefined()
  @IsString()
  resource?: string;
}

/** `GET /api/audit-logs/export/csv?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD` — both optional. */
export class AuditExportQueryDto extends PickType(AuditQueryDto, ['dateFrom', 'dateTo'] as const) {}
