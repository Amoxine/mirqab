import { Module } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import { TenantController } from './controllers/tenant.controller';
import { TenantService } from './services/tenant.service';
import { QuotasModule } from '../quotas/quotas.module';

/**
 * Tenant Management Module
 *
 * Provides CRUD operations for tenants, user-tenant assignment,
 * and tenant isolation utilities.
 *
 * Exports:
 *  - TenantController: REST endpoints for tenant management
 *  - TenantService: Business logic for tenant operations
 *
 * Dependencies:
 *  - PrismaClient (from @open-gateway/database) — provided directly
 */
@Module({
  imports: [QuotasModule],
  controllers: [TenantController],
  providers: [
    TenantService,
    {
      provide: 'PRISMA_CLIENT',
      useValue: prisma,
    },
  ],
  exports: [TenantService],
})
// A Nest module is a decorator-only class by design; the rule cannot see @Module's metadata.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class TenantsModule {}
