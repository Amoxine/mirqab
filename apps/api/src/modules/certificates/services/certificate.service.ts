import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

/** A SHA-256 fingerprint as Tyk renders it: 64 lowercase hex chars (live-verified, RSA and EC). */
const FINGERPRINT = /^[0-9a-f]{64}$/;
const FINGERPRINT_LENGTH = 64;

/**
 * Exact ownership: `id` is `<org_id><fingerprint>`, so peel the fixed-length fingerprint off the end
 * and compare what is left to `tykOrgId` for EQUALITY. A `startsWith` here is only correct while
 * every org id has the same length — an org id that is a prefix of another's (`og-a` vs `og-a5ef…`)
 * would "own" the longer org's certificates. Peeling the suffix makes it exact for any org id shape.
 *
 * Exported so `ApiService` (create/update) applies the same rule to `upstreamMutualTls.certificateId`
 * — without it a tenant could reference another tenant's cert, and push traffic under its key.
 */
export const isCertOwnedByOrg = (id: string, tykOrgId: string): boolean =>
  id.length > FINGERPRINT_LENGTH &&
  id.slice(0, id.length - FINGERPRINT_LENGTH) === tykOrgId &&
  FINGERPRINT.test(id.slice(id.length - FINGERPRINT_LENGTH));

/**
 * Certificate upload/list/delete (U19, WP26a) — a thin passthrough over `/tyk/certs`, deliberately
 * with NO local table. Tyk is already the store of record (S7: Redis-shared, org-scoped, and its
 * own GET never carries private key material), so mirroring it into Postgres would only be a second
 * place the private key could leak into if anyone ever paired a create-DTO field with a Prisma
 * `create()` — passthrough closes that class of bug by construction rather than by discipline.
 *
 * Tenant isolation is enforced HERE, not trusted to Tyk. Every cert id Tyk hands back is
 * `<org_id><sha256 fingerprint>` (live-verified: the suffix is exactly the 64 lowercase hex chars of
 * `fingerprint`, for RSA and EC keys), so ownership is an exact comparison — see
 * `isCertOwnedByOrg`. It is needed on every path because Tyk's scoping is weaker than it looks:
 * its LIST `org_id` filter is a PREFIX match (live-measured: `?org_id=og-len` returned the certs of
 * org `og-lenprobe`), and GET/DELETE/USE take only a bare id. Org ids are server-generated 39-char
 * values today so the prefix case is unreachable through the API, but that is a convention, not a
 * constraint (`tenants` has no length check) — so the check must not depend on it.
 */
@Injectable()
export class CertificateService {
  private readonly logger = new Logger(CertificateService.name);

  constructor(private readonly tykClient: TykClientService) {}

  private assertOwned(id: string, tykOrgId: string): void {
    if (!isCertOwnedByOrg(id, tykOrgId)) {
      // 404, not 403: which certificate ids exist outside this tenant is not the caller's business.
      throw new NotFoundException(`Certificate ${id} not found`);
    }
  }

  async create(dto: UploadCertificateDto, tenantId: string): Promise<CertificateDetail> {
    const { tykOrgId } = await loadTenantScope(tenantId);
    const { id } = await this.tykClient.uploadCert(dto.pem, tykOrgId);
    try {
      return toDetail(await this.tykClient.getCert(id));
    } catch (err) {
      // Live-measured: Tyk ACCEPTS an ed25519 certificate ("Certificate added") but then cannot read
      // it back (GET 404s). Left alone that is a stored private key the UI can neither list nor
      // delete, so take it out again rather than leave it orphaned.
      await this.tykClient.deleteCert(id, tykOrgId).catch((cleanupErr: unknown) => {
        this.logger.error(
          `Certificate ${id} could not be read back and could not be removed either: ` +
            (cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)),
        );
      });
      this.logger.warn(`Certificate upload rolled back: ${err instanceof Error ? err.message : String(err)}`);
      throw new BadRequestException(
        'The certificate was stored but the gateway could not read it back (unsupported key type?); it was removed.',
      );
    }
  }

  /** No bulk-detail endpoint exists on `/tyk/certs` — list gives ids only, so this fetches each
   * one's metadata individually. A handful of certs per tenant is the expected shape; a cert that
   * fails to load (e.g. a race with a concurrent delete) is dropped rather than failing the page. */
  async findAll(tenantId: string): Promise<CertificateDetail[]> {
    const { tykOrgId } = await loadTenantScope(tenantId);
    // Tyk's `org_id` filter is a prefix match, so it can hand back ANOTHER tenant's ids (one whose
    // org id merely starts with ours). Drop them before fetching anything, not after.
    const ids = (await this.tykClient.listCertIds(tykOrgId)).filter((id) => isCertOwnedByOrg(id, tykOrgId));
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
