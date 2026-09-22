import { PartialType } from '@nestjs/swagger';
import { CreateApiDto } from './create-api.dto';
import { ApiStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

export class UpdateApiDto extends PartialType(CreateApiDto) {
  @IsOptional()
  @IsEnum(ApiStatus)
  status?: ApiStatus;
}
