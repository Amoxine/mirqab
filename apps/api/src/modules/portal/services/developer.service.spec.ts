import 'reflect-metadata';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import * as kratosModule from '../../../common/ory/kratos';
import { DeveloperService } from './developer.service';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    tenant: { findUnique: jest.fn() },
    developer: { create: jest.fn() },
  },
}));

jest.mock('../../../common/ory/kratos', () => ({
  kratosCreateIdentity: jest.fn(),
  kratosSendVerificationEmail: jest.fn(),
}));

type Fn = jest.Mock;
// Cast once, here, rather than at each call site: prisma's generated client types `create`/
// `findUnique` as bound class methods, which trips `@typescript-eslint/unbound-method` the moment
// one is handed to `expect(...)` — a plain `Record<string, jest.Mock>` never was one to begin with.
const db = prisma as unknown as { tenant: { findUnique: Fn }; developer: { create: Fn } };
const kratos = kratosModule as unknown as { kratosCreateIdentity: Fn; kratosSendVerificationEmail: Fn };

// Registration cleans up an orphaned identity through a raw fetch (no HydraAdminService-style
// wrapper exists for Kratos admin deletes yet) — stubbed so a failure path test never hits the network.
const fetchMock: Fn = jest.fn().mockResolvedValue({ ok: true });
global.fetch = fetchMock as unknown as typeof fetch;

const dto = { tenantSlug: 'acme', email: 'dev@example.com', name: 'Ada Lovelace', password: 'Passw0rd!23' };

describe('DeveloperService', () => {
  let service: DeveloperService;

  beforeEach(() => {
    jest.resetAllMocks();
    fetchMock.mockResolvedValue({ ok: true });
    service = new DeveloperService();
  });

  it('404s an unknown tenant slug before ever calling Kratos', async () => {
    db.tenant.findUnique.mockResolvedValue(null);

    await expect(service.register(dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(kratos.kratosCreateIdentity).not.toHaveBeenCalled();
  });

  it('registers, provisions the Developer row, and sends the verification email', async () => {
    db.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', slug: 'acme' });
    kratos.kratosCreateIdentity.mockResolvedValue({ id: 'kratos-1', traits: { email: dto.email } });
    db.developer.create.mockResolvedValue({ id: 'dev-1', email: dto.email, name: dto.name });

    const result = await service.register(dto);

    expect(result).toEqual({ id: 'dev-1', email: dto.email, name: dto.name });
    expect(db.developer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { tenantId: 'tenant-1', email: dto.email, name: dto.name, kratosIdentityId: 'kratos-1' },
      }),
    );
    expect(kratos.kratosSendVerificationEmail).toHaveBeenCalledWith(dto.email);
  });

  it('409s when Kratos already has this email (one identity per email, globally)', async () => {
    db.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', slug: 'acme' });
    kratos.kratosCreateIdentity.mockRejectedValue(new Error('409 email exists'));

    await expect(service.register(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(db.developer.create).not.toHaveBeenCalled();
  });

  it('cleans up the Kratos identity when the Developer row fails to write, and still answers 409 on a duplicate', async () => {
    db.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', slug: 'acme' });
    kratos.kratosCreateIdentity.mockResolvedValue({ id: 'kratos-1', traits: { email: dto.email } });
    db.developer.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.5.0',
        meta: { target: ['tenant_id', 'email'] },
      }),
    );

    await expect(service.register(dto)).rejects.toBeInstanceOf(ConflictException);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toContain('/admin/identities/kratos-1');
    expect(init).toMatchObject({ method: 'DELETE' });
  });

  it('never fails registration over a courier hiccup', async () => {
    db.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', slug: 'acme' });
    kratos.kratosCreateIdentity.mockResolvedValue({ id: 'kratos-1', traits: { email: dto.email } });
    db.developer.create.mockResolvedValue({ id: 'dev-1', email: dto.email, name: dto.name });
    kratos.kratosSendVerificationEmail.mockRejectedValue(new Error('SMTP down'));

    await expect(service.register(dto)).resolves.toEqual({ id: 'dev-1', email: dto.email, name: dto.name });
  });
});
