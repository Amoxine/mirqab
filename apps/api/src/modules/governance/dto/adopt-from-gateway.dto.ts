import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AdoptFromGatewayDto {
  @ApiProperty({
    description:
      'One of the configured gateway node admin URLs (TYK_ADMIN_URLS) to adopt this API’s ' +
      'current definition from. Validated against the configured node list, not fetched as-is.',
    example: 'http://tyk-gateway-2:8081/tyk',
  })
  @IsString()
  @IsNotEmpty()
  nodeUrl!: string;
}
