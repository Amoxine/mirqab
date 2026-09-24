import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CertificateService, type CertificateDetail } from '../services/certificate.service';
import { UploadCertificateDto } from '../dto/certificate.dto';
import { TenantIsolationGuard } from '../../../common/guards/tenant-isolation.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CurrentTenant } from '../../../common/decorators/current-tenant.decorator';
import { Audit } from '../../../common/decorators/audit.decorator';

/**
 * Certificate upload/list/delete (U19, WP26a) — upstream mTLS only. This is NOT client-certificate
 * auth at the gateway (cut, O13): nothing here touches `X-Tyk-Server.clientCertificates`, only
 * `X-Tyk-Upstream.mutualTLS` (`ApiConfigDto.upstreamMutualTls`, wired in `tyk-mappers.ts`).
 */
@ApiTags('Certificates')
@ApiBearerAuth()
@UseGuards(TenantIsolationGuard, PermissionsGuard)
@Controller('certificates')
export class CertificateController {
  constructor(private readonly certificates: CertificateService) {}

  @Get()
  @Permissions('cert:read')
  @ApiOperation({ summary: "List this tenant's certificates" })
  async findAll(@CurrentTenant() tenantId: string): Promise<{ success: true; data: CertificateDetail[] }> {
    return { success: true, data: await this.certificates.findAll(tenantId) };
  }

  @Post()
  @Permissions('cert:create')
  @Audit('cert:created', 'Certificate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Upload a certificate (and, for a client certificate, its private key)' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Never echoes the private key back' })
  async create(
    @Body() dto: UploadCertificateDto,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: CertificateDetail }> {
    return { success: true, data: await this.certificates.create(dto, tenantId) };
  }

  @Delete(':id')
  @Permissions('cert:delete')
  @Audit('cert:deleted', 'Certificate')
  @ApiOperation({ summary: 'Delete a certificate' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Not found, or belongs to another tenant' })
  async remove(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<{ success: true; data: { message: string } }> {
    return { success: true, data: await this.certificates.remove(id, tenantId) };
  }
}
