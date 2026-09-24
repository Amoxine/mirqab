import { IsUrl, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsAllowedProxyUrl } from '../../api-management/dto/proxy-url.validator';

export class CreateWebhookSubscriptionDto {
  @ApiProperty({ description: 'The API definition whose events this subscribes to' })
  @IsUUID()
  apiId!: string;

  @ApiProperty({
    example: 'https://example.com/hooks/tyk',
    description:
      'Where signed delivery POSTs land. Same SSRF denylist as every other upstream/receiver URL ' +
      'in this platform (proxy-url.validator.ts) — a denied host is refused with 400.',
  })
  @IsUrl({ require_tld: false, require_protocol: true, protocols: ['http', 'https'] })
  @IsAllowedProxyUrl()
  receiverUrl!: string;
}
