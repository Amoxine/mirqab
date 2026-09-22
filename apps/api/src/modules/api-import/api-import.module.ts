import { Module, type MiddlewareConsumer, type NestModule, RequestMethod } from '@nestjs/common';
import { ApiImportController } from './controllers/api-import.controller';
import { ApiImportService } from './services/api-import.service';
import { SpectralLintService } from './services/spectral-lint.service';
import { ApiManagementModule } from '../api-management/api-management.module';
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
  imports: [ApiManagementModule],
  controllers: [ApiImportController],
  providers: [ApiImportService, SpectralLintService],
})
export class ApiImportModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Scoped to this one route. Applied app-wide it would swallow every other route's JSON body,
    // because it reads any content type (see the middleware's own note).
    consumer
      .apply(specBodyMiddleware)
      .forRoutes({ path: 'apis/import', method: RequestMethod.POST });
  }
}
