import { Module, type MiddlewareConsumer, type NestModule, RequestMethod } from '@nestjs/common';
import { ApiImportController } from './controllers/api-import.controller';
import { ApiSpecController } from './controllers/api-spec.controller';
import { ApiSpecUpdateController } from './controllers/api-spec-update.controller';
import { SpecSourceController, SpecUpdatesController } from './controllers/spec-source.controller';
import { ApiImportService } from './services/api-import.service';
import { ApiSpecService } from './services/api-spec.service';
import { SpecUpdateService } from './services/spec-update.service';
import { SpectralLintService } from './services/spectral-lint.service';
import { SpecCandidateService } from './services/spec-candidate.service';
import { SpecSourceService } from './services/spec-source.service';
import { SpecSourceScheduler } from './services/spec-source.scheduler';
import { ApiManagementModule } from '../api-management/api-management.module';
import { AuditModule } from '../audit/audit.module';
import { ObservabilityModule } from '../observability/observability.module';
import { SpecFetchModule } from '../spec-fetch/spec-fetch.module';
import { specBodyMiddleware } from './spec-body.middleware';

/**
 * OAS import (WP24). A module of its own rather than more files inside `api-management`, for two
 * reasons: it needs a route-scoped body parser (`configure()` below), and the route table stays
 * readable when the only thing that mounts a 5 MB text parser is the module that needs one.
 *
 * It imports `ApiManagementModule` for `ApiService`, which that module already exported — importing
 * a spec ends by calling the same `create()` a hand-written API uses, so there is one creation path.
 */
@Module({
  // OAS-08: the guarded fetcher (the only path to a tenant spec URL), AuditService for the
  // SPEC_UPDATE_DETECTED row, MetricsService's registry for the overdue gauge.
  imports: [ApiManagementModule, SpecFetchModule, AuditModule, ObservabilityModule],
  controllers: [ApiImportController, ApiSpecController, ApiSpecUpdateController, SpecSourceController, SpecUpdatesController],
  providers: [
    ApiImportService,
    SpectralLintService,
    ApiSpecService,
    SpecUpdateService,
    SpecCandidateService,
    SpecSourceService,
    SpecSourceScheduler,
  ],
})
export class ApiImportModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Scoped to the four routes that take a raw document. Applied app-wide it would swallow every
    // other route's JSON body, because it reads any content type (see the middleware's own note).
    consumer
      .apply(specBodyMiddleware)
      .forRoutes(
        { path: 'apis/import', method: RequestMethod.POST },
        { path: 'apis/import/preview', method: RequestMethod.POST },
        // OAS-04. POST only: `GET apis/:id/spec` has no body, and no other POST matches these shapes.
        { path: 'apis/:id/spec', method: RequestMethod.POST },
        { path: 'apis/:id/spec/preview', method: RequestMethod.POST },
      );
  }
}
