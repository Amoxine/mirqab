import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateApplicationDto {
  @ApiProperty({ example: 'My Mobile App', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ example: 'The iOS/Android client for my product' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
