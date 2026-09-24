import 'reflect-metadata';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { ApplicationService } from './application.service';

jest.mock('@open-gateway/database', () => ({
  prisma: {
    application: {
      count: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
  },
}));

type Fn = jest.Mock;
const db = prisma.application as unknown as Record<'count' | 'create' | 'findMany' | 'findUnique', Fn>;

const DEVELOPER = 'dev-1';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    developerId: DEVELOPER,
    name: 'My App',
    description: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    _count: { subscriptions: 0 },
    ...overrides,
  };
}

describe('ApplicationService', () => {
  let service: ApplicationService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new ApplicationService();
  });

  describe('create', () => {
    it('creates below the cap', async () => {
      db.count.mockResolvedValue(3);
      db.create.mockResolvedValue(row());

      const detail = await service.create({ name: 'My App' }, DEVELOPER);

      expect(detail.id).toBe('app-1');
      expect(db.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { developerId: DEVELOPER, name: 'My App', description: undefined } }),
      );
    });

    it('refuses at the application cap (abuse control)', async () => {
      db.count.mockResolvedValue(20);

      await expect(service.create({ name: 'One too many' }, DEVELOPER)).rejects.toBeInstanceOf(ConflictException);
      expect(db.create).not.toHaveBeenCalled();
    });

    it('maps a duplicate name to 409', async () => {
      db.count.mockResolvedValue(0);
      db.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.5.0',
          meta: { target: ['developer_id', 'name'] },
        }),
      );

      await expect(service.create({ name: 'My App' }, DEVELOPER)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('findRow / findOne (cross-account guard)', () => {
    it('404s when the application does not exist at all', async () => {
      db.findUnique.mockResolvedValue(null);

      await expect(service.findOne('missing', DEVELOPER)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403s when the application belongs to a different developer — not 404', async () => {
      db.findUnique.mockResolvedValue(row({ developerId: 'someone-else' }));

      await expect(service.findOne('app-1', DEVELOPER)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns the detail for the owning developer', async () => {
      db.findUnique.mockResolvedValue(row());

      await expect(service.findOne('app-1', DEVELOPER)).resolves.toMatchObject({ id: 'app-1' });
    });
  });

  describe('findAll', () => {
    it('scopes the list to this developer only', async () => {
      db.findMany.mockResolvedValue([row()]);

      await service.findAll(DEVELOPER);

      expect(db.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { developerId: DEVELOPER } }));
    });
  });
});
