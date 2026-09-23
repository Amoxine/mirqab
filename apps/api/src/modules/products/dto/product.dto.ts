import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateProductDto {
  @ApiProperty({ example: 'Payments Suite', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 'payments-suite', description: 'URL-safe slug, unique per tenant' })
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'Slug must be URL-safe (lowercase letters, numbers, hyphens)',
  })
  slug!: string;

  @ApiPropertyOptional({ example: 'Everything a merchant needs to take a payment' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'ApiDefinition ids to bundle. Each must belong to this tenant.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  apiIds?: string[];
}

export class UpdateProductDto extends PartialType(CreateProductDto) {}
