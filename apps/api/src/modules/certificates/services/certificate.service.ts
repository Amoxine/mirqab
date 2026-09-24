import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import { TykClientService, type TykCertMeta } from '../../tyk-integration/services/tyk-client.service';
import { loadTenantScope } from '../../tyk-integration/services/tenant-scope';
import type { UploadCertificateDto } from '../dto/certificate.dto';

/** Never the private key — `TykCertMeta` structurally cannot carry it (see that type's doc comment). */
export interface CertificateDetail {
  id: string;
  commonName: string | null;
  fingerprint: string;
  hasPrivate: boolean;
  isCa: boolean;
  notBefore: string;
  notAfter: string;
}

function toDetail(cert: TykCertMeta): CertificateDetail {
  return {
    id: cert.id,
    commonName: cert.subject.CommonName ?? null,
    fingerprint: cert.fingerprint,
    hasPrivate: cert.has_private,
    isCa: cert.is_ca,
    notBefore: cert.not_before,
    notAfter: cert.not_after,
  };
}

/**
 * Certificate upload/list/delete (U19, WP26a) — a thin passthrough over `/tyk/certs`, deliberately
 * with NO local table. Tyk is already the store of record (S7: Redis-shared, org-scoped, and its
 * own GET never carries private key material), so mirroring it into Postgres would only be a second
 * place the private key could leak into if anyone ever paired a create-DTO field with a Prisma
 * `create()` — passthrough closes that class of bug by construction rather than by discipline.
 *
 * `Tenant.tykOrgId` is `og-<tenantId>` (fixed length) and every cert id Tyk hands back is
 * `<org_id><fingerprint>` (live-verified) — so `id.startsWith(tykOrgId)` is an exact org-id
 * comparison, not a fuzzy prefix match, and is asserted before EVERY id-scoped call. Tyk's own
 * `org_id` query param scopes LIST correctly (also live-verified), but GET/DELETE take only an id —
 * nothing stops a caller who already knows another tenant's cert id from asking for it by id alone,
 * so this is the actual tenant-isolation boundary for those two calls, not a defensive extra.
 */
@Injectable()
export class CertificateService {
  constructor(private readonly tykClient: TykClientService) {}

  private assertOwned(id: string, tykOrgId: string): void {
    if (!id.startsWith(tykOrgId)) {
      // 404, not 403: which certificate ids exist outside this tenant is not the caller's business.
      throw new NotFoundException(`Certificate ${id} not found`);
    }
  }

  async create(dto: UploadCertificateDto, tenantId: string): Promise<CertificateDetail> {
    const { tykOrgId } = await loadTenantScope(tenantId);
    const { id } = await this.tykClient.uploadCert(dto.pem, tykOrgId);
    return toDetail(await this.tykClient.getCert(id));
  }

  /** No bulk-detail endpoint exists on `/tyk/certs` — list gives ids only, so this fetches each
   * one's metadata individually. A handful of certs per tenant is the expected shape; a cert that
   * fails to load (e.g. a race with a concurrent delete) is dropped rather than failing the page. */
  async findAll(tenantId: string): Promise<CertificateDetail[]> {
    const { tykOrgId } = await loadTenantScope(tenantId);
    const ids = await this.tykClient.listCertIds(tykOrgId);
    const certs = await Promise.all(
      ids.map((id) => this.tykClient.getCert(id).then(toDetail).catch(() => null)),
    );
    return certs.filter((c): c is CertificateDetail => c !== null);
  }

  /**
   * Refused (409) while any of this tenant's APIs still references the certificate.
   *
   * Live-measured against v5.15.0: deleting a certificate does NOT stop an API that already has it
   * attached from presenting it — the API kept answering 200 from the demanding upstream after the
   * delete, after the upstream connection was dropped, and after a gateway reload (the gateway only
   * logs "Can't retrieve certificate"). Detaching it from the API in place DOES stop it at once
   * (400 from the upstream). So delete is not revoke, and an unguarded delete would leave both a
   * dangling reference and a credential the operator believes is gone but is still in use. Revoke
   * = detach (`PATCH /apis/:id {config:{upstreamMutualTls:null}}`), then delete.
   */
  async remove(id: string, tenantId: string): Promise<{ message: string }> {
    const { tykOrgId } = await loadTenantScope(tenantId);
    this.assertOwned(id, tykOrgId);

    const attached = await prisma.apiDefinition.findMany({
      where: { tenantId, config: { path: ['upstreamMutualTls', 'certificateId'], equals: id } },
      select: { name: true },
    });
    if (attached.length > 0) {
      throw new ConflictException(
        `Certificate is attached to ${String(attached.length)} API(s) (${attached.map((a) => a.name).join(', ')}). ` +
          'Detach it from each API first — deleting an attached certificate does not stop that API presenting it.',
      );
    }

    await this.tykClient.deleteCert(id, tykOrgId);
    return { message: `Certificate ${id} deleted.` };
  }
}

// Re-exported so a caller (the API-config validator, a future WP) can 404 an unowned certificateId
// the same way `remove` does, without re-deriving the ownership rule.
export const isCertOwnedByOrg = (id: string, tykOrgId: string): boolean => id.startsWith(tykOrgId);
