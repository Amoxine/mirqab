import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from './pagination.dto';

/**
 * Query of `GET /tenants/:id/users`: a page, plus an optional case-insensitive substring matched
 * against the member's name or email. A DTO rather than a loose `@Query('q')` because the global
 * ValidationPipe forbids non-whitelisted query keys.
 */
export class ListTenantUsersDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(254)
  q?: string;
}
