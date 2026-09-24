import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './common/database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { ApiManagementModule } from './modules/api-management/api-management.module';
import { ApiImportModule } from './modules/api-import/api-import.module';
import { TykIntegrationModule } from './modules/tyk-integration/tyk-integration.module';
import { KeysModule } from './modules/keys/keys.module';
import { OAuthClientsModule } from './modules/oauth-clients/oauth-clients.module';
import { QuotasModule } from './modules/quotas/quotas.module';
import { PlansModule } from './modules/plans/plans.module';
import { ProductsModule } from './modules/products/products.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AuditModule } from './modules/audit/audit.module';
import { PortalModule } from './modules/portal/portal.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    // The ONLY forRoot: AuthModule used to call it again with limit 5, and the last registration won
    // for every route in the app. ThrottlerModule is @Global(), so any per-route @Throttle() override
    // would resolve against this one — none exist today (see docs/security.md). Per-IP baseline,
    // generous enough for the dashboard's polling (gateway status every 30s, lists every 5s while syncing).
    ThrottlerModule.forRoot([{ ttl: 60000, limit: process.env.NODE_ENV === 'production' ? 100 : 1000 }]),
    CommonModule,
    DatabaseModule,
    AuthModule,
    TenantsModule,
    ApiManagementModule,
    ApiImportModule,
    TykIntegrationModule,
    KeysModule,
    OAuthClientsModule,
    QuotasModule,
    PlansModule,
    ProductsModule,
    AnalyticsModule,
    AuditModule,
    PortalModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Without this, ThrottlerGuard never runs and every @Throttle() in the app is inert — login was
    // brute-forceable despite its 5/min decorator.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Without this, JwtAuthGuard only ran on controllers that explicitly declared
    // @UseGuards(JwtAuthGuard, ...) — a controller that forgot it (or a future one that never adds it)
    // was reachable with no auth check at all. @Public() still exempts a route from THIS guard (see
    // public.decorator.ts); routes that also need tenant/permission checks still add
    // TenantIsolationGuard/PermissionsGuard themselves, this only makes "is there a valid session"
    // universal.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
// A Nest module is a decorator-only class by design; the rule cannot see @Module's metadata.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AppModule {}
