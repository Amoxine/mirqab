import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { DeveloperAuthGuard } from '../guards/developer-auth.guard';
import { CurrentDeveloper } from '../decorators/current-developer.decorator';
import type { DeveloperPayload } from '../../../common/types';
import { ProductService, type ProductDetail } from '../../products/services/product.service';
import { PlanService, type PlanDetail } from '../../plans/services/plan.service';

/**
 * What a developer may subscribe to — every read scoped to THIS developer's own `tenantId`, read
 * off their session (never a header, never a body field a caller could point at another tenant).
 * `ProductService`/`PlanService` are the dashboard's own (WP18), reused as-is: their `findOne`
 * already 404s a cross-tenant id, which is exactly the cross-tenant-catalog acceptance this
 * controller has to hold.
 */
@ApiTags('Portal')
@ApiBearerAuth()
@Public()
@UseGuards(DeveloperAuthGuard)
@Controller('portal/catalog')
export class PortalCatalogController {
  constructor(
    private readonly products: ProductService,
    private readonly plans: PlanService,
  ) {}

  @Get('products')
  @ApiOperation({ summary: 'Products published in this developer\'s tenant' })
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
}
