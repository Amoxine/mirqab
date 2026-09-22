import { Module, forwardRef } from '@nestjs/common';
import { TykIntegrationModule } from '../tyk-integration/tyk-integration.module';
import { QuotasModule } from '../quotas/quotas.module';
import { KeyService } from './services/key.service';
import { KeyController } from './controllers/key.controller';

@Module({
  imports: [
    TykIntegrationModule,
    forwardRef(() => QuotasModule),
  ],
  controllers: [KeyController],
  providers: [KeyService],
  exports: [KeyService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class KeysModule {}
