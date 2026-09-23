import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProductService, type ProductDetail } from '../services/product.service';
import { CreateProductDto, UpdateProductDto } from '../dto/product.dto';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';

@ApiTags('Products')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('products')
export class ProductController {
  constructor(private readonly products: ProductService) {}

  @Post()
  @Permissions('product:create')
  @ApiOperation({ summary: 'Create a product (a bundle of APIs)' })
  @ApiResponse({ status: 201, description: 'Product created' })
  @Audit('product:created', 'Product')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateProductDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: ProductDetail }> {
    return { success: true, data: await this.products.create(dto, tenantId) };
  }

  @Get()
  @Permissions('product:read')
  @ApiOperation({ summary: 'List products' })
  async findAll(@CurrentTenant() tenantId: string): Promise<{ success: true; data: ProductDetail[] }> {
    return { success: true, data: await this.products.findAll(tenantId) };
  }

  @Get(':id')
  @Permissions('product:read')
  @ApiOperation({ summary: 'Get a product' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: ProductDetail }> {
    return { success: true, data: await this.products.findOne(id, tenantId) };
  }

  @Patch(':id')
  @Permissions('product:update')
  @ApiOperation({
    summary: 'Update a product',
    description: 'Sending `apiIds` replaces the membership; omitting it leaves the membership alone.',
  })
  @Audit('product:updated', 'Product')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: ProductDetail }> {
    return { success: true, data: await this.products.update(id, dto, tenantId) };
  }

  @Delete(':id')
  @Permissions('product:delete')
  @ApiOperation({ summary: 'Delete a product. The APIs it bundled are untouched.' })
  @Audit('product:deleted', 'Product')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: { message: string } }> {
    return { success: true, data: await this.products.remove(id, tenantId) };
  }
}
