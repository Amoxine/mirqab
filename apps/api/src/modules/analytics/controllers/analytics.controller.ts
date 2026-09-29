import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AnalyticsService } from '../services/analytics.service';
import { TrafficAnalyticsService } from '../services/traffic-analytics.service';
import {
  AnalyticsExportQueryDto,
  AnalyticsListQueryDto,
  AnalyticsRangeQueryDto,
  AnalyticsTimeSeriesQueryDto,
  AnalyticsTopApisQueryDto,
  AnalyticsTrafficQueryDto,
} from '../dto/analytics-query.dto';
import type {
  AnalyticsApiRowResponse,
  AnalyticsHealthResponse,
  AnalyticsKeyRowResponse,
  AnalyticsOverviewResponse,
  AnalyticsStatusCodeResponse,
  AnalyticsTimeSeriesPointResponse,
  AnalyticsTopApiResponse,
  AnalyticsTrafficResponse,
} from '../dto/analytics-response.dto';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';

@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Permissions('analytics:read')
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly trafficService: TrafficAnalyticsService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Aggregate request/latency/error totals for the range' })
  async getOverview(
    @CurrentTenant() tenantId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<AnalyticsOverviewResponse> {
    return this.analyticsService.getOverview(tenantId, query.range);
  }

  @Get('timeseries')
  @ApiOperation({ summary: 'Bucketed requests, errors and latency for charts' })
  async getTimeSeries(
    @CurrentTenant() tenantId: string,
    @Query() query: AnalyticsTimeSeriesQueryDto,
  ): Promise<AnalyticsTimeSeriesPointResponse[]> {
    return this.analyticsService.getTimeSeries(tenantId, query.metric, query.range);
  }

  @Get('apis')
  @ApiOperation({ summary: 'Per-API usage rollup, busiest first (at most `limit` rows)' })
  async getApiMetrics(
    @CurrentTenant() tenantId: string,
    @Query() query: AnalyticsListQueryDto,
  ): Promise<AnalyticsApiRowResponse[]> {
    return this.analyticsService.getApiMetrics(tenantId, query.range, query.limit);
  }

  @Get('keys')
  @ApiOperation({ summary: 'Per-key usage rollup, busiest first (at most `limit` rows)' })
  async getKeyMetrics(
    @CurrentTenant() tenantId: string,
    @Query() query: AnalyticsListQueryDto,
  ): Promise<AnalyticsKeyRowResponse[]> {
    return this.analyticsService.getKeyMetrics(tenantId, query.range, query.limit);
  }

  @Get('top-apis')
  @ApiOperation({ summary: 'Top APIs by request count' })
  async getTopApis(
    @CurrentTenant() tenantId: string,
    @Query() query: AnalyticsTopApisQueryDto,
  ): Promise<AnalyticsTopApiResponse[]> {
    return this.analyticsService.getTopApis(tenantId, query.range, query.limit);
  }

  @Get('status-codes')
  @ApiOperation({ summary: 'Response status-code breakdown' })
  async getStatusCodes(
    @CurrentTenant() tenantId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<AnalyticsStatusCodeResponse[]> {
    return this.analyticsService.getStatusCodes(tenantId, query.range);
  }

  @Get('traffic')
  @ApiOperation({
    summary: 'Filtered traffic KPIs, time series and endpoint breakdowns',
    description:
      'Reads the raw request table so it can filter by API, key, method, status, path and latency. ' +
      "Every filter is optional; ids that are not the caller's tenant's match nothing.",
  })
  async getTraffic(
    @CurrentTenant() tenantId: string,
    @Query() query: AnalyticsTrafficQueryDto,
  ): Promise<AnalyticsTrafficResponse> {
    return this.trafficService.getTraffic(tenantId, query);
  }

  @Get('health')
  @ApiOperation({ summary: 'Readiness of the Tyk Pump analytics pipeline' })
  async getHealth(@CurrentTenant() tenantId: string): Promise<AnalyticsHealthResponse> {
    return this.analyticsService.getHealth(tenantId);
  }

  // `@Permissions` here REPLACES the controller-level `analytics:read` (Reflector#getAllAndOverride,
  // see permissions.guard.ts) — this route needs `analytics:export` specifically, not both.
  @Get('export')
  @Permissions('analytics:export')
  @ApiOperation({
    summary: 'Export analytics as CSV',
    description:
      'Streams text/csv (never buffers the full export in memory). Only `format=csv` is supported today.',
  })
  async exportCsv(
    @Res() res: Response,
    @CurrentTenant() tenantId: string,
    @Query() query: AnalyticsExportQueryDto,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="analytics-${String(Date.now())}.csv"`,
    );
    await this.analyticsService.streamExportCsv(tenantId, query.range, res);
  }
}
