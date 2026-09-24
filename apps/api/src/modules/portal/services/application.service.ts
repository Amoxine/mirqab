import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import type { CreateApplicationDto } from '../dto/create-application.dto';

export interface ApplicationDetail {
  id: string;
  name: string;
  description: string | null;
  subscriptionCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A developer's own applications never number more than this (abuse control, plan acceptance). */
const MAX_APPLICATIONS_PER_DEVELOPER = 20;

const withSubscriptionCount = {
  _count: { select: { subscriptions: true } },
} satisfies Prisma.ApplicationInclude;
type ApplicationRow = Prisma.ApplicationGetPayload<{ include: typeof withSubscriptionCount }>;

function toDetail(row: ApplicationRow): ApplicationDetail {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    subscriptionCount: row._count.subscriptions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A developer's registered applications (WP22). Every read/write is scoped by `developerId`, never
 * by a bare application id a caller supplied — reading someone else's application answers 403
 * (ForbiddenException), the acceptance's own wording for the cross-account case, deliberately not
 * the 404 a cross-TENANT catalog lookup answers (ProductService et al): an application id is not
 * treated as sensitive to enumerate within one tenant's own developer pool the way another
 * tenant's whole catalog is.
 */
@Injectable()
export class ApplicationService {
  async create(dto: CreateApplicationDto, developerId: string): Promise<ApplicationDetail> {
    const existing = await prisma.application.count({ where: { developerId } });
    if (existing >= MAX_APPLICATIONS_PER_DEVELOPER) {
      throw new ConflictException(
        `You already have ${String(MAX_APPLICATIONS_PER_DEVELOPER)} applications, the most this account allows.`,
      );
    }

    try {
      const row = await prisma.application.create({
        data: { developerId, name: dto.name, description: dto.description },
        include: withSubscriptionCount,
      });
      return toDetail(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`You already have an application named "${dto.name}".`);
      }
      throw err;
    }
  }

  async findAll(developerId: string): Promise<ApplicationDetail[]> {
    const rows = await prisma.application.findMany({
      where: { developerId },
      include: withSubscriptionCount,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDetail);
  }

  async findOne(id: string, developerId: string): Promise<ApplicationDetail> {
    return toDetail(await this.findRow(id, developerId));
  }

  /** Tenant/dashboard code 404s a cross-tenant row; this 403s a cross-account one (see class doc). */
  async findRow(id: string, developerId: string): Promise<ApplicationRow> {
    const row = await prisma.application.findUnique({ where: { id }, include: withSubscriptionCount });
    if (!row) {
      throw new NotFoundException('Application not found');
    }
    if (row.developerId !== developerId) {
      throw new ForbiddenException('This application belongs to a different account');
    }
    return row;
  }
}
