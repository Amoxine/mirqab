import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SettingsService, TenantSettings } from '../services/settings.service';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';

/**
 * Read-only settings (U17, WP14). Node health and the reload action live on `GatewayStatusController`
 * (`/gateway/*`), which already owned that prefix — this controller is only the config view that is
 * genuinely new: the tenant's Tyk org and the two analytics retention windows.
 */
@ApiTags('Settings')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @Permissions('settings:read')
  @ApiOperation({ summary: "The tenant's Tyk org id and the analytics retention windows — all read-only config" })
  async getSettings(@CurrentTenant() tenantId: string): Promise<TenantSettings> {
    return this.settingsService.getSettings(tenantId);
  }
}
