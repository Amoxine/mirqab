import { Module } from '@nestjs/common';
import { CertificateController } from './controllers/certificate.controller';
import { CertificateService } from './services/certificate.service';
import { TykIntegrationModule } from '../tyk-integration/tyk-integration.module';

@Module({
  imports: [TykIntegrationModule],
  controllers: [CertificateController],
  providers: [CertificateService],
  exports: [CertificateService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class CertificatesModule {}
