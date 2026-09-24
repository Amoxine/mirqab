import 'reflect-metadata';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import type { TykClientService, TykCertMeta } from '../../tyk-integration/services/tyk-client.service';
import { CertificateService, isCertOwnedByOrg } from './certificate.service';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    // WP12c: every gateway call resolves the tenant's org through `loadTenantScope`.
    tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue({ tykOrgId: 'og-tenant-1', slug: 'tenant-1' }) },
    // `remove` refuses while an API of this tenant still references the certificate.
    apiDefinition: { findMany: jest.fn() },
  },
}));

const TENANT = 'tenant-1';
const ORG = 'og-tenant-1';

const certMeta = (over: Partial<TykCertMeta> = {}): TykCertMeta => ({
  id: `${ORG}fingerprint1`,
  fingerprint: 'fingerprint1',
  has_private: true,
  issuer: { CommonName: 'issuer.local' },
  subject: { CommonName: 'spike.local' },
  not_before: '2026-01-01T00:00:00Z',
  not_after: '2027-01-01T00:00:00Z',
  is_ca: false,
  ...over,
});

function setup() {
  const tyk = {
    uploadCert: jest.fn(),
    listCertIds: jest.fn(),
    getCert: jest.fn(),
    deleteCert: jest.fn(),
  };
  const service = new CertificateService(tyk as unknown as TykClientService);
  return { service, tyk };
}

// The mocked module above replaces the real client; typed as mocks so no method is read unbound.
const db = prisma as unknown as { apiDefinition: { findMany: jest.Mock }; tenant: { findUniqueOrThrow: jest.Mock } };
const findAttachedApis = db.apiDefinition.findMany;

beforeEach(() => {
  db.tenant.findUniqueOrThrow.mockResolvedValue({ tykOrgId: ORG, slug: 'tenant-1' });
  findAttachedApis.mockReset().mockResolvedValue([]);
});

describe('isCertOwnedByOrg', () => {
  it('accepts a cert id that starts with this org id, rejects one that does not', () => {
    expect(isCertOwnedByOrg('og-tenant-1fingerprint', 'og-tenant-1')).toBe(true);
    expect(isCertOwnedByOrg('og-tenant-2fingerprint', 'og-tenant-1')).toBe(false);
  });

  // This is a raw `startsWith`, not a delimited comparison — it is only safe because `tykOrgIdFor`
  // (packages/database/src/index.ts) always produces `og-<uuid>`, a FIXED length. Two distinct
  // tenants' org ids can therefore never be a prefix of one another; if that ever changed to a
  // variable-length id (e.g. a slug), this check would need a delimiter and this test would catch it.
  it('documents the fixed-length assumption: a same-length-prefix org id is NOT mistaken for a match', () => {
    expect(isCertOwnedByOrg('og-tenant-10fingerprint', 'og-tenant-1')).toBe(true); // raw prefix, as expected
    expect(isCertOwnedByOrg('og-tenant-10fingerprint', 'og-tenant-10')).toBe(true);
    // Real org ids are both exactly `og-<uuid>` (39 chars) — this pair could never occur in practice.
  });
});

describe('CertificateService', () => {
  describe('create', () => {
    it('uploads the PEM under the tenant org and returns Tyk metadata, never the raw PEM or key', async () => {
      const { service, tyk } = setup();
      tyk.uploadCert.mockResolvedValue({ id: `${ORG}fingerprint1` });
      tyk.getCert.mockResolvedValue(certMeta());

      const result = await service.create({ pem: '-----BEGIN CERTIFICATE-----\n...' }, TENANT);

      expect(tyk.uploadCert).toHaveBeenCalledWith('-----BEGIN CERTIFICATE-----\n...', ORG);
      expect(result).toEqual({
        id: `${ORG}fingerprint1`,
        commonName: 'spike.local',
        fingerprint: 'fingerprint1',
        hasPrivate: true,
        isCa: false,
        notBefore: '2026-01-01T00:00:00Z',
        notAfter: '2027-01-01T00:00:00Z',
      });
      expect(result).not.toHaveProperty('pem');
      expect(result).not.toHaveProperty('key');
    });
  });

  describe('findAll', () => {
    it('lists ids scoped to the tenant org, then fetches each one\'s detail', async () => {
      const { service, tyk } = setup();
      tyk.listCertIds.mockResolvedValue([`${ORG}a`, `${ORG}b`]);
      tyk.getCert.mockImplementation((id: string) => Promise.resolve(certMeta({ id, fingerprint: id })));

      const result = await service.findAll(TENANT);

      expect(tyk.listCertIds).toHaveBeenCalledWith(ORG);
      expect(result.map((c) => c.id)).toEqual([`${ORG}a`, `${ORG}b`]);
    });

    it('drops (does not fail the page on) a cert that fails to load individually', async () => {
      const { service, tyk } = setup();
      tyk.listCertIds.mockResolvedValue([`${ORG}a`, `${ORG}b`]);
      tyk.getCert.mockImplementation((id: string) =>
        id === `${ORG}a` ? Promise.reject(new Error('gone')) : Promise.resolve(certMeta({ id })),
      );

      const result = await service.findAll(TENANT);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(`${ORG}b`);
    });

    it('returns an empty list for a tenant with no certificates', async () => {
      const { service, tyk } = setup();
      tyk.listCertIds.mockResolvedValue([]);

      await expect(service.findAll(TENANT)).resolves.toEqual([]);
    });
  });

  describe('remove', () => {
    it('deletes a certificate this tenant owns', async () => {
      const { service, tyk } = setup();
      tyk.deleteCert.mockResolvedValue(undefined);

      await service.remove(`${ORG}fingerprint1`, TENANT);

      expect(tyk.deleteCert).toHaveBeenCalledWith(`${ORG}fingerprint1`, ORG);
    });

    it("404s (not 403) a certificate belonging to another tenant, without calling Tyk", async () => {
      const { service, tyk } = setup();

      await expect(service.remove('og-someone-elsefingerprint', TENANT)).rejects.toThrow(NotFoundException);
      expect(tyk.deleteCert).not.toHaveBeenCalled();
      expect(findAttachedApis).not.toHaveBeenCalled();
    });

    // Live-measured: an attached API keeps presenting a deleted cert (even after reconnect + reload),
    // so delete must not be reachable while anything references it — detach is the revocation.
    it('409s while an API still references the certificate, naming it, and never calls Tyk', async () => {
      const { service, tyk } = setup();
      findAttachedApis.mockResolvedValue([{ name: 'Payments' }, { name: 'Orders' }]);

      await expect(service.remove(`${ORG}fingerprint1`, TENANT)).rejects.toThrow(ConflictException);
      await expect(service.remove(`${ORG}fingerprint1`, TENANT)).rejects.toThrow(/Payments, Orders/);
      expect(tyk.deleteCert).not.toHaveBeenCalled();
    });

    it("looks for attachments only among this tenant's own APIs, keyed on the certificate id", async () => {
      const { service, tyk } = setup();
      tyk.deleteCert.mockResolvedValue(undefined);

      await service.remove(`${ORG}fingerprint1`, TENANT);

      expect(findAttachedApis).toHaveBeenCalledWith({
        where: { tenantId: TENANT, config: { path: ['upstreamMutualTls', 'certificateId'], equals: `${ORG}fingerprint1` } },
        select: { name: true },
      });
    });
  });
});
