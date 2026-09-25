import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PutSpecSourceDto } from '../dto/spec-source.dto';
import { SpecUpdateQueryDto } from '../dto/spec-update-query.dto';
import { SpecCandidateService, type Candidate, type CandidateSummary, type SpecUpdateItem } from '../services/spec-candidate.service';
import { SpecSourceService, type CheckOutcome, type SpecSourceView } from '../services/spec-source.service';
import type { SpecUpdateResult } from '../services/spec-update.service';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';
import type { UserPayload } from '../../../common/types';

/**
 * OAS-08: an API's watched spec URL and the versions it proposed. Existing permissions only: reading is
 * `api:read`; everything that changes what is watched or applied is `api:update`. Another tenant's API
 * or candidate is 404.
 */
@ApiTags('APIs')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('apis')
export class SpecSourceController {
  constructor(
    private readonly sources: SpecSourceService,
    private readonly candidates: SpecCandidateService,
  ) {}

  @Get(':id/spec-source')
  @Permissions('api:read')
  @ApiOperation({ summary: 'The spec URL this API is watched at (redacted), and the last check' })
  async getSource(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() tenantId: string): Promise<{ success: true; data: SpecSourceView }> {
    return { success: true, data: await this.sources.get(tenantId, id) };
  }

  @Put(':id/spec-source')
  @Permissions('api:update')
  @ApiOperation({
    summary: 'Watch this API’s OpenAPI document at a URL',
    description: '`url` is optional on an edit; changing it resets what was learnt about the old one. At most 50 per tenant.',
  })
  @ApiResponse({ status: 422, description: 'SPEC_FETCH_BAD_URL / SPEC_FETCH_BLOCKED_TARGET' })
  // The interceptor stores this body; its URL redaction strips the query string (C1).
  @Audit('api:updated', 'ApiDefinition')
  async putSource(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PutSpecSourceDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: SpecSourceView }> {
    return { success: true, data: await this.sources.put(tenantId, id, dto) };
  }

  @Delete(':id/spec-source')
  @Permissions('api:update')
  @ApiOperation({ summary: 'Stop watching; a pending proposal is withdrawn' })
  @Audit('api:updated', 'ApiDefinition')
  async removeSource(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() tenantId: string): Promise<{ success: true; data: { removed: true } }> {
    return { success: true, data: await this.sources.remove(tenantId, id) };
  }

  /** Not audited: it changes no configuration; a detected change writes its own SPEC_UPDATE_DETECTED row. */
  @Post(':id/spec-source/check')
  @Permissions('api:update')
  @ApiOperation({ summary: 'Check the spec URL now' })
  @ApiResponse({ status: 429, description: 'SPEC_CHECK_COOLDOWN: checked less than 30 s ago' })
  @HttpCode(HttpStatus.OK)
  async check(@Param('id', ParseUUIDPipe) id: string, @CurrentTenant() tenantId: string): Promise<{ success: true; data: CheckOutcome }> {
    return { success: true, data: await this.sources.checkNow(tenantId, id) };
  }

  @Get(':id/spec-candidates')
  @Permissions('api:read')
  @ApiOperation({ summary: 'The proposed version (if any) and the last 20 detected ones' })
  async listCandidates(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: { pending: Candidate | null; history: CandidateSummary[] } }> {
    return { success: true, data: await this.candidates.list(tenantId, id) };
  }

  @Get(':id/spec-candidates/:cid/diff')
  @Permissions('api:read')
  @ApiOperation({
    summary: 'What applying the proposed version would change, against the CURRENT version',
    description: 'The OAS-04 dry run. Send its `versionNo` as `expectedVersion` to the apply.',
  })
  @ApiResponse({ status: 409, description: 'CANDIDATE_STALE: no longer pending' })
  async diff(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cid', ParseUUIDPipe) cid: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: SpecUpdateResult }> {
    return { success: true, data: await this.candidates.diff(tenantId, id, cid) };
  }

  @Post(':id/spec-candidates/:cid/apply')
  @Permissions('api:update')
  @ApiOperation({ summary: 'Apply the proposed version (OAS-04 apply, compare-and-set on expectedVersion)' })
  @ApiResponse({ status: 409, description: 'SPEC_VERSION_STALE (re-diff), SPEC_REMOVES_GOVERNED_ENDPOINTS, SPEC_GOVERNANCE_CHANGED, CANDIDATE_STALE' })
  @Audit('api:updated', 'ApiDefinition')
  @HttpCode(HttpStatus.OK)
  async apply(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cid', ParseUUIDPipe) cid: string,
    @Query() query: SpecUpdateQueryDto,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserPayload | undefined,
  ): Promise<{ success: true; data: SpecUpdateResult }> {
    return {
      success: true,
      data: await this.candidates.apply(tenantId, id, cid, {
        expectedVersion: query.expectedVersion,
        acknowledgeRemoved: query.acknowledgeRemoved ?? false,
        userId: user?.sub,
      }),
    };
  }

  @Post(':id/spec-candidates/:cid/dismiss')
  @Permissions('api:update')
  @ApiOperation({ summary: 'Dismiss the proposed version: that content is not proposed again' })
  @Audit('api:updated', 'ApiDefinition')
  @HttpCode(HttpStatus.OK)
  async dismiss(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cid', ParseUUIDPipe) cid: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: UserPayload | undefined,
  ): Promise<{ success: true; data: { state: 'DISMISSED' } }> {
    return { success: true, data: await this.candidates.dismiss(tenantId, id, cid, user?.sub) };
  }
}

/** `GET /spec-updates`: the tenant's APIs with a pending proposal (dashboard card, list badge). */
@ApiTags('APIs')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('spec-updates')
export class SpecUpdatesController {
  constructor(private readonly candidates: SpecCandidateService) {}

  @Get()
  @Permissions('api:read')
  @ApiOperation({ summary: 'APIs whose watched spec URL proposes a new version (≤ 100, newest first)' })
  async list(@CurrentTenant() tenantId: string): Promise<{ success: true; data: { items: SpecUpdateItem[] } }> {
    return { success: true, data: await this.candidates.pendingUpdates(tenantId) };
  }
}
