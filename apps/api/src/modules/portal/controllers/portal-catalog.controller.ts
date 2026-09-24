import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { DeveloperAuthGuard } from '../guards/developer-auth.guard';
import { CurrentDeveloper } from '../decorators/current-developer.decorator';
import type { DeveloperPayload } from '../../../common/types';
import { ProductService, type ProductDetail } from '../../products/services/product.service';
import { PlanService, type PlanDetail } from '../../plans/services/plan.service';
import { ApiService } from '../../api-management/services/api.service';
import { gatewayListenPath } from '../../api-management/services/tyk-mappers';
import { loadTenantScope } from '../../tyk-integration/services/tenant-scope';

/**
 * What a developer may subscribe to — every read scoped to THIS developer's own `tenantId`, read
 * off their session (never a header, never a body field a caller could point at another tenant).
 * `ProductService`/`PlanService` are the dashboard's own (WP18), reused as-is: their `findOne`
 * already 404s a cross-tenant id, which is exactly the cross-tenant-catalog acceptance this
 * controller has to hold.
 */
/** `GET /portal/catalog/apis/:id` (WP23) — just enough of `ApiDetail` for the docs page: the
 * generated OAS document (WP17's endpoint list reads the same field, same resolution — the
 * generated doc, not an imported spec's original shape) and the try-it console's request target. */
export interface PortalApiDoc {
  id: string;
  name: string;
  authType: string;
  authHeaderName?: string;
  /** `/{tenantSlug}{listenPath}` — what the gateway actually routes on (O10), pre-computed here so
   * the frontend never re-derives the tenant-prefix formula. */
  gatewayListenPath: string;
  oasDocument: unknown;
}

@ApiTags('Portal')
@ApiBearerAuth()
@Public()
@UseGuards(DeveloperAuthGuard)
@Controller('portal/catalog')
export class PortalCatalogController {
  constructor(
    private readonly products: ProductService,
    private readonly plans: PlanService,
    private readonly apis: ApiService,
  ) {}

  @Get('products')
  @ApiOperation({ summary: 'Products published in this developer\'s tenant' })
  // GAP (WP23, flagged rather than silently built around): the plan's acceptance says "catalog
  // lists only portal-visible products" and assumes Product carries a visibility flag — it does
  // not (schema.prisma has no published/visible/portalVisible column, and there is no dashboard UI
  // to manage Products at all yet, WP18 shipped the backend only). Filtering on an invented flag
  // would be worse than being honest: every product in the tenant is "published" today because
  // nothing else exists for it to be. Revisit once WP18/22's Product model actually gets one.
  async findProducts(@CurrentDeveloper() developer: DeveloperPayload): Promise<ProductDetail[]> {
    return this.products.findAll(developer.tenantId);
  }

  @Get('products/:id')
  @ApiOperation({ summary: 'One product — 404 for another tenant\'s id, same as the dashboard route' })
  async findProduct(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDeveloper() developer: DeveloperPayload,
  ): Promise<ProductDetail> {
    return this.products.findOne(id, developer.tenantId);
  }

  @Get('plans')
  @ApiOperation({ summary: 'Published (active) plans in this developer\'s tenant' })
  async findPlans(@CurrentDeveloper() developer: DeveloperPayload): Promise<PlanDetail[]> {
    const all = await this.plans.findAll(developer.tenantId);
    return all.filter((plan) => plan.active);
  }

  @Get('plans/:id')
  @ApiOperation({ summary: 'One plan — 404 for another tenant\'s id or an unpublished one' })
  async findPlan(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDeveloper() developer: DeveloperPayload,
  ): Promise<PlanDetail> {
    const plan = await this.plans.findOne(id, developer.tenantId);
    if (!plan.active) {
      // Same shape as "not found" for a cross-tenant id — an unpublished plan is not something
      // this developer is entitled to see the details of either.
      throw new NotFoundException(`Plan ${id} not found`);
    }
    return plan;
  }

  @Get('apis/:id')
  @ApiOperation({
    summary: 'One API\'s generated OAS document and gateway request target, for the docs page',
    description: 'Tenant-scoped the same way as products/plans above — 404 for another tenant\'s id.',
  })
  async findApi(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentDeveloper() developer: DeveloperPayload,
  ): Promise<PortalApiDoc> {
    const api = await this.apis.findOne(id, developer.tenantId);
    const tenant = await loadTenantScope(developer.tenantId);
    return {
      id: api.id,
      name: api.name,
      authType: api.authType,
      authHeaderName: api.config.authHeaderName,
      gatewayListenPath: gatewayListenPath(tenant.slug, api.listenPath),
      oasDocument: api.oasDocument,
    };
  }
}
