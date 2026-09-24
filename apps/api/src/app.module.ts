import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { LoggerModule } from 'nestjs-pino';
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
import { GovernanceModule } from './modules/governance/governance.module';
import { PortalModule } from './modules/portal/portal.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { McpModule } from './modules/mcp/mcp.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    // `pino` and `nestjs-pino` have been installed and unused since the first commit; WP20 is what
    // finally wires them. One structured JSON line per request, on the same stdout the edge and the
    // gateway already write JSON to, so `docker compose logs` is greppable by request id.
    //
    // `genReqId` prefers the edge's X-Request-Id (infra/edge/Caddyfile sets it from
    // {http.request.uuid}) so one id spans the edge access log and every api log line for that
    // request; `traceparent` is copied onto each line so a log can be joined to the trace the
    // collector received. No transport: this is a container log, and pino-pretty in front of it
    // would cost a worker thread to make JSON un-greppable.
    LoggerModule.forRoot({
      pinoHttp: {
        genReqId: (req) => (typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : randomUUID()),
        customProps: (req) => ({ traceparent: req.headers.traceparent }),
        // Prometheus scrapes every 15s and the container HEALTHCHECK polls every 30s; logging both
        // buries every real request.
        autoLogging: { ignore: (req) => req.url === '/api/metrics' || req.url === '/api/health' },
        redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-tyk-authorization"]'],
      },
    }),
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
    GovernanceModule,
    ObservabilityModule,
    PortalModule,
    WebhooksModule,
    McpModule,
    SettingsModule,
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
