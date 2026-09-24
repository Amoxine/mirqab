import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class UploadCertificateDto {
  @ApiProperty({
    description:
      'PEM-encoded certificate. For a client certificate (upstream mTLS), append its private key ' +
      'PEM right after the certificate PEM in the same string.',
  })
  @IsString()
  @MinLength(1)
  pem!: string;
}
