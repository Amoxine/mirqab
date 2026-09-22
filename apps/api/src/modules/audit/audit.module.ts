import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditService } from './services/audit.service';
import { AuditController } from './controllers/audit.controller';
import { AuditLogInterceptor } from './interceptors/audit-log.interceptor';

@Module({
  controllers: [AuditController],
  // Global: @Audit() on any controller in any module is inert unless the interceptor is registered
  providers: [AuditService, { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor }],
  exports: [AuditService],
})
// A Nest module is a decorator-only class by design; the rule cannot see @Module's metadata.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AuditModule {}
