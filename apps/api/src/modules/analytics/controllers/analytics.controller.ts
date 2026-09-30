import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AnalyticsService } from '../services/analytics.service';
import { TrafficSearchService, type TrafficSearchDetail, type TrafficSearchPage } from '../search/traffic-search.service';
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
    private readonly searchService: TrafficSearchService,
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

  // Both permissions, deliberately stricter than this controller's `analytics:read`: a search returns other
  // people's captured request and response bodies across every API, and the per-API inspector that shows the
  // same data is gated by `api:update` (api.controller.ts `:id/traffic`). `@Permissions` here REPLACES the
  // class-level list (Reflector#getAllAndOverride, see permissions.guard.ts), so `analytics:read` is repeated.
  @Post('traffic/search')
  @Permissions('analytics:read', 'api:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Search captured request/response detail',
    description:
      'Typed clauses over the redacted search projection: status, latency, method, path prefix, API, key, headers and ' +
      'body words. The tenant scope and a time window are always applied. 400 SEARCH_INVALID for a bad clause, 422 ' +
      'SEARCH_TOO_BROAD when the 3 s budget is exceeded. Bodies are searchable only up to 16 KiB each.',
  })
  async searchTraffic(@CurrentTenant() tenantId: string, @Body() body: unknown): Promise<TrafficSearchPage> {
    return this.searchService.search(tenantId, body);
  }

  @Get('traffic/search/:id')
  @Permissions('analytics:read', 'api:update')
  @ApiOperation({ summary: 'One search result with its headers and bodies', description: '`ts` must be the value the search returned: it selects the day partition.' })
  async searchTrafficDetail(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Query('ts') ts: string,
  ): Promise<TrafficSearchDetail> {
    return this.searchService.detail(tenantId, id, ts);
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
