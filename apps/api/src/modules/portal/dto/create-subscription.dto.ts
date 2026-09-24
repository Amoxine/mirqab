import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CreateSubscriptionDto {
  @ApiProperty({ description: 'Product id, must belong to this developer\'s own tenant' })
  @IsUUID('4')
  productId!: string;

  @ApiProperty({ description: 'Plan id, must belong to this developer\'s own tenant and be active' })
  @IsUUID('4')
  planId!: string;
}
