import { Module } from '@nestjs/common';
import { TykIntegrationModule } from '../tyk-integration/tyk-integration.module';
import { PlansModule } from '../plans/plans.module';
import { ProductsModule } from '../products/products.module';
import { PortalAuthController } from './controllers/portal-auth.controller';
import { PortalCatalogController } from './controllers/portal-catalog.controller';
import { PortalApplicationsController } from './controllers/portal-applications.controller';
import { PortalSubscriptionsController } from './controllers/portal-subscriptions.controller';
import { DeveloperService } from './services/developer.service';
import { ApplicationService } from './services/application.service';
import { SubscriptionService } from './services/subscription.service';

/**
 * The portal's own auth domain (WP22) — see `DeveloperAuthGuard`'s doc comment for how that stays
 * separate from the dashboard's. `PlansModule`/`ProductsModule` are imported for their exported
 * `PlanService`/`ProductService` (`PortalCatalogController` reuses them as-is); `TykIntegrationModule`
 * for `SubscriptionService`'s key issuance.
 */
@Module({
  imports: [TykIntegrationModule, PlansModule, ProductsModule],
  controllers: [
    PortalAuthController,
    PortalCatalogController,
    PortalApplicationsController,
    PortalSubscriptionsController,
  ],
  providers: [DeveloperService, ApplicationService, SubscriptionService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module: the class is only a metadata carrier
export class PortalModule {}
