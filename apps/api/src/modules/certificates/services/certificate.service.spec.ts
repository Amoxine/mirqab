import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
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
/** A cert id is `<org_id><sha256 fingerprint>`; Tyk renders the fingerprint as 64 lowercase hex (live-verified). */
const FP = 'a1b2c3d4'.repeat(8);
const fp = (ch: string): string => ch.repeat(64);
const OWN = `${ORG}${FP}`;

const certMeta = (over: Partial<TykCertMeta> = {}): TykCertMeta => ({
  id: OWN,
  fingerprint: FP,
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
  // A realistic default-tenant cert id: og-<uuid> (39 chars) + a 64-hex fingerprint.
  const DEFAULT_ORG = 'og-a5ef2c83-3583-47dd-aa09-780776b97c68';
  const DEFAULT_CERT = `${DEFAULT_ORG}${FP}`;

  it('accepts a cert id whose org part is exactly this org', () => {
    expect(isCertOwnedByOrg(OWN, ORG)).toBe(true);
    expect(isCertOwnedByOrg(DEFAULT_CERT, DEFAULT_ORG)).toBe(true);
  });

  it('rejects another tenant\'s cert, including one of the same length whose prefix differs', () => {
    expect(isCertOwnedByOrg(`og-tenant-2${FP}`, ORG)).toBe(false);
    expect(isCertOwnedByOrg(DEFAULT_CERT, 'og-a5ef2c83-3583-47dd-aa09-780776b97c69')).toBe(false);
  });

  // The old check was `id.startsWith(tykOrgId)`, exact only while every org id has the same length.
  // These are the short-org cases from the independent verification: each one used to "own" the
  // default tenant's certificates. Unreachable through the API today (org ids are server-generated),
  // but `tenants` has no length constraint, so the guard must not lean on that.
  it.each(['og-a', 'og-a5ef2c83', 'og-', 'og-a5ef2c83-3583-47dd-aa09-780776b97c6'])(
    'rejects a caller whose org id is a strict prefix of the real owner\'s (%s)',
    (shortOrg) => {
      expect(isCertOwnedByOrg(DEFAULT_CERT, shortOrg)).toBe(false);
    },
  );

  it('rejects the reverse too: a caller org that merely EXTENDS the real owner\'s', () => {
    expect(isCertOwnedByOrg(DEFAULT_CERT, `${DEFAULT_ORG}-x`)).toBe(false);
  });

  it('rejects an id whose suffix is not a 64-char lowercase-hex fingerprint', () => {
    expect(isCertOwnedByOrg(`${ORG}fingerprint1`, ORG)).toBe(false); // too short
    expect(isCertOwnedByOrg(`${ORG}${'A'.repeat(64)}`, ORG)).toBe(false); // uppercase
    expect(isCertOwnedByOrg(`${ORG}${'g'.repeat(64)}`, ORG)).toBe(false); // not hex
    expect(isCertOwnedByOrg(`${ORG}${FP}0`, ORG)).toBe(false); // 65 chars
    expect(isCertOwnedByOrg(ORG, ORG)).toBe(false); // no fingerprint at all
    expect(isCertOwnedByOrg('', ORG)).toBe(false);
  });
});

describe('CertificateService', () => {
  describe('create', () => {
    it('uploads the PEM under the tenant org and returns Tyk metadata, never the raw PEM or key', async () => {
      const { service, tyk } = setup();
      tyk.uploadCert.mockResolvedValue({ id: OWN });
      tyk.getCert.mockResolvedValue(certMeta());

      const result = await service.create({ pem: '-----BEGIN CERTIFICATE-----\n...' }, TENANT);

      expect(tyk.uploadCert).toHaveBeenCalledWith('-----BEGIN CERTIFICATE-----\n...', ORG);
      expect(result).toEqual({
        id: OWN,
        commonName: 'spike.local',
        fingerprint: FP,
        hasPrivate: true,
        isCa: false,
        notBefore: '2026-01-01T00:00:00Z',
        notAfter: '2027-01-01T00:00:00Z',
      });
      expect(result).not.toHaveProperty('pem');
      expect(result).not.toHaveProperty('key');
    });

    // Live-measured: Tyk accepts an ed25519 certificate ("Certificate added") but its GET then 404s.
    // Without the rollback that is a stored private key the UI can neither list nor delete.
    it('removes an upload the gateway cannot read back, rather than orphaning a stored private key', async () => {
      const { service, tyk } = setup();
      tyk.uploadCert.mockResolvedValue({ id: OWN });
      tyk.getCert.mockRejectedValue(new Error('Certificate with given SHA256 fingerprint not found'));
      tyk.deleteCert.mockResolvedValue(undefined);

      await expect(service.create({ pem: 'x' }, TENANT)).rejects.toThrow(BadRequestException);
      expect(tyk.deleteCert).toHaveBeenCalledWith(OWN, ORG);
    });

    it('still answers 400 when that cleanup delete fails too (and says so in the log, not the response)', async () => {
      const { service, tyk } = setup();
      tyk.uploadCert.mockResolvedValue({ id: OWN });
      tyk.getCert.mockRejectedValue(new Error('gone'));
      tyk.deleteCert.mockRejectedValue(new Error('gateway down'));

      await expect(service.create({ pem: 'x' }, TENANT)).rejects.toThrow(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('lists ids scoped to the tenant org, then fetches each one\'s detail', async () => {
      const { service, tyk } = setup();
      tyk.listCertIds.mockResolvedValue([`${ORG}${fp('a')}`, `${ORG}${fp('b')}`]);
      tyk.getCert.mockImplementation((id: string) => Promise.resolve(certMeta({ id })));

      const result = await service.findAll(TENANT);

      expect(tyk.listCertIds).toHaveBeenCalledWith(ORG);
      expect(result.map((c) => c.id)).toEqual([`${ORG}${fp('a')}`, `${ORG}${fp('b')}`]);
    });

    // Live-measured: Tyk's `?org_id=` filter is a PREFIX match, so tenant `og-tenant-1` is handed the
    // certs of `og-tenant-10` (and `og-tenant-1x`...) too. They must be dropped before anything is
    // fetched — otherwise a short-org tenant lists (and learns the ids of) a longer org's certificates.
    it("drops ids Tyk's prefix-matching list returns for OTHER orgs, without fetching them", async () => {
      const { service, tyk } = setup();
      const foreign = [`og-tenant-10${fp('c')}`, `og-tenant-1-extra${fp('d')}`];
      tyk.listCertIds.mockResolvedValue([OWN, ...foreign]);
      tyk.getCert.mockImplementation((id: string) => Promise.resolve(certMeta({ id })));

      const result = await service.findAll(TENANT);

      expect(result.map((c) => c.id)).toEqual([OWN]);
      expect(tyk.getCert).toHaveBeenCalledTimes(1);
      expect(tyk.getCert).toHaveBeenCalledWith(OWN);
    });

    it('drops (does not fail the page on) a cert that fails to load individually', async () => {
      const { service, tyk } = setup();
      tyk.listCertIds.mockResolvedValue([`${ORG}${fp('a')}`, `${ORG}${fp('b')}`]);
      tyk.getCert.mockImplementation((id: string) =>
        id === `${ORG}${fp('a')}` ? Promise.reject(new Error('gone')) : Promise.resolve(certMeta({ id })),
      );

      const result = await service.findAll(TENANT);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(`${ORG}${fp('b')}`);
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

      await service.remove(OWN, TENANT);

      expect(tyk.deleteCert).toHaveBeenCalledWith(OWN, ORG);
    });

    it("404s (not 403) a certificate belonging to another tenant, without calling Tyk", async () => {
      const { service, tyk } = setup();

      await expect(service.remove(`og-someone-else${FP}`, TENANT)).rejects.toThrow(NotFoundException);
      expect(tyk.deleteCert).not.toHaveBeenCalled();
      expect(findAttachedApis).not.toHaveBeenCalled();
    });

    it("404s a longer org's cert for a tenant whose org id is a strict prefix of it, without calling Tyk", async () => {
      const { service, tyk } = setup();

      await expect(service.remove(`og-tenant-10${FP}`, TENANT)).rejects.toThrow(NotFoundException);
      expect(tyk.deleteCert).not.toHaveBeenCalled();
    });

    // Live-measured: an attached API keeps presenting a deleted cert (even after reconnect + reload),
    // so delete must not be reachable while anything references it — detach is the revocation.
    it('409s while an API still references the certificate, naming it, and never calls Tyk', async () => {
      const { service, tyk } = setup();
      findAttachedApis.mockResolvedValue([{ name: 'Payments' }, { name: 'Orders' }]);

      await expect(service.remove(OWN, TENANT)).rejects.toThrow(ConflictException);
      await expect(service.remove(OWN, TENANT)).rejects.toThrow(/Payments, Orders/);
      expect(tyk.deleteCert).not.toHaveBeenCalled();
    });

    it("looks for attachments only among this tenant's own APIs, keyed on the certificate id", async () => {
      const { service, tyk } = setup();
      tyk.deleteCert.mockResolvedValue(undefined);

      await service.remove(OWN, TENANT);

      expect(findAttachedApis).toHaveBeenCalledWith({
        where: { tenantId: TENANT, config: { path: ['upstreamMutualTls', 'certificateId'], equals: OWN } },
        select: { name: true },
      });
    });
  });
});
