import { Controller, Get, Param, Query, UseGuards, ParseIntPipe, ParseUUIDPipe, Res } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { AuditService, CSV_MAX_ROWS } from '../services/audit.service';
import { AuditQueryDto, AuditExportQueryDto } from '../dto/audit-query.dto';
import { AnalyticsRangeQueryDto } from '../../analytics/dto/analytics-query.dto';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';

/**
 * Audit log reads. Every route needs an explicit permission: this controller ran with authentication
 * only, so any signed-in user — including a self-registered one with no tenant, whose token made
 * Prisma drop the tenant filter entirely — could read and export every tenant's audit trail.
 */
@ApiTags('Audit')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@ApiResponse({ status: 403, description: 'Missing permission, or caller has no tenant' })
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @Permissions('audit:read')
  @ApiOperation({ summary: 'List audit logs with filters' })
  async findAll(@CurrentTenant() tenantId: string | undefined, @Query() query: AuditQueryDto) {
    return this.auditService.findAll(tenantId, {
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
      userId: query.userId,
      action: query.action,
      resource: query.resource,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get('stats')
  @Permissions('audit:read')
  @ApiOperation({ summary: 'Get audit statistics' })
  async getStats(
    @CurrentTenant() tenantId: string | undefined,
    @Query('range') range = '30d',
  ) {
    return this.auditService.getStats(tenantId, range);
  }

  // Declared before ':id', which would otherwise swallow 'export'.
  @Get('export/csv')
  @Permissions('audit:export')
  @ApiOperation({
    summary: 'Export audit logs as CSV',
    description: `Returns text/csv as an attachment, newest first, capped at ${String(CSV_MAX_ROWS)} rows. dateFrom/dateTo are inclusive days (YYYY-MM-DD).`,
  })
  async exportCsv(
    @Res({ passthrough: true }) res: Response,
    @CurrentTenant() tenantId: string | undefined,
    @Query() query: AuditExportQueryDto,
  ) {
    const csv = await this.auditService.exportCsv(tenantId, {
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${String(Date.now())}.csv"`);
    res.send(csv);
  }

  // Two path segments, so ':id' (one segment) can never swallow this regardless of declaration
  // order — grouped here for readability, next to the other read routes.
  @Get('traffic/:apiDefId')
  @Permissions('analytics:read')
  @ApiOperation({ summary: "An audit row's API, rolled up over the same window (view traffic)" })
  async findRelatedTraffic(
    @CurrentTenant() tenantId: string | undefined,
    @Param('apiDefId', ParseUUIDPipe) apiDefId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ) {
    return this.auditService.findRelatedTraffic(tenantId, apiDefId, query.range);
  }

  // Declared after the static routes above: ':id' would otherwise swallow /stats
  @Get(':id')
  @Permissions('audit:read')
  @ApiOperation({ summary: 'Get single audit log entry' })
  async findOne(
    @CurrentTenant() tenantId: string | undefined,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.auditService.findOne(BigInt(id), tenantId);
  }
}
