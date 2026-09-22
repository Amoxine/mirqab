import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';
import { OAuthClientService } from '../services/oauth-client.service';
import {
  CreateOAuthClientDto,
  OAuthClientListDto,
  OAuthClientSecretDto,
} from '../dto/oauth-client.dto';

/**
 * OAuth2 client credentials for APIs with `authType: OAUTH`.
 *
 * Deliberately guarded by the `key:*` permissions rather than new ones: an OAuth2 client is the
 * same thing as an API key from an operator's point of view — a credential issued against one API,
 * shown once, revocable — and the seed catalog already grants those to the roles that should hold it.
 */
@ApiTags('OAuth2 Clients')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('oauth-clients')
export class OAuthClientController {
  constructor(private readonly oauthClients: OAuthClientService) {}

  @Post()
  @Permissions('key:create')
  @Audit('oauth-client:created')
  @ApiOperation({ summary: 'Create an OAuth2 client for an API (secret returned once)' })
  @ApiResponse({ status: HttpStatus.CREATED, type: OAuthClientSecretDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'API does not use OAuth2, or is not synced' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'API not found' })
  async create(
    @Body() dto: CreateOAuthClientDto,
    @CurrentTenant() tenantId: string,
  ): Promise<OAuthClientSecretDto> {
    return this.oauthClients.create(dto, tenantId);
  }

  @Get()
  @Permissions('key:read')
  @ApiOperation({ summary: 'List the OAuth2 clients of one API' })
  @ApiQuery({ name: 'apiDefId', required: true, type: String, format: 'uuid' })
  @ApiResponse({ status: HttpStatus.OK, type: OAuthClientListDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'API not found' })
  async findAll(
    @Query('apiDefId', ParseUUIDPipe) apiDefId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<OAuthClientListDto> {
    return { data: await this.oauthClients.findByApi(apiDefId, tenantId) };
  }

  @Post(':id/rotate')
  @Permissions('key:update')
  @Audit('oauth-client:updated')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Replace the client secret (returned once); the client id is unchanged' })
  @ApiResponse({ status: HttpStatus.OK, type: OAuthClientSecretDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Client not found' })
  async rotate(
    @Param('id', ParseUUIDPipe) clientId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<OAuthClientSecretDto> {
    return this.oauthClients.rotate(clientId, tenantId);
  }

  @Delete(':id')
  @Permissions('key:revoke')
  @Audit('oauth-client:revoked')
  @ApiOperation({ summary: 'Revoke an OAuth2 client — its gateway policy is removed first' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Client revoked' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Client not found' })
  async revoke(
    @Param('id', ParseUUIDPipe) clientId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ message: string }> {
    return this.oauthClients.revoke(clientId, tenantId);
  }
}
