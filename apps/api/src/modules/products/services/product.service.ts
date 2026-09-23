import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import type { CreateProductDto, UpdateProductDto } from '../dto/product.dto';

export interface ProductApiSummary {
  id: string;
  name: string;
  slug: string;
}

export interface ProductDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  apis: ProductApiSummary[];
  createdAt: Date;
  updatedAt: Date;
}

const withApis = {
  apis: { include: { apiDef: { select: { id: true, name: true, slug: true } } } },
} satisfies Prisma.ProductInclude;

type ProductRow = Prisma.ProductGetPayload<{ include: typeof withApis }>;

function toDetail(row: ProductRow): ProductDetail {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    apis: row.apis.map((link) => link.apiDef),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Products are a control-plane grouping only — they create no gateway object, which is why this
 * service never touches `TykClientService`. Access to the APIs in a product is granted by the key's
 * own access rights; the product is what a developer browses, not what the gateway enforces.
 */
@Injectable()
export class ProductService {
  async create(dto: CreateProductDto, tenantId: string): Promise<ProductDetail> {
    const apiIds = await this.assertApisOwned(dto.apiIds ?? [], tenantId);

    try {
      const row = await prisma.product.create({
        data: {
          tenantId,
          name: dto.name,
          slug: dto.slug,
          description: dto.description,
          apis: { create: apiIds.map((apiDefId) => ({ apiDefId })) },
        },
        include: withApis,
      });
      return toDetail(row);
    } catch (err) {
      throw this.asConflict(err, dto.name, dto.slug);
    }
  }

  async findAll(tenantId: string): Promise<ProductDetail[]> {
    const rows = await prisma.product.findMany({
      where: { tenantId },
      include: withApis,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDetail);
  }

  async findOne(id: string, tenantId: string): Promise<ProductDetail> {
    return toDetail(await this.findRow(id, tenantId));
  }

  /**
   * `apiIds` is a full replacement when present, not a merge: the caller sends the membership it
   * wants and gets exactly that. Omitting the field leaves the membership alone, so a rename does
   * not silently empty a product.
   */
  async update(id: string, dto: UpdateProductDto, tenantId: string): Promise<ProductDetail> {
    await this.findRow(id, tenantId);
    const apiIds = dto.apiIds ? await this.assertApisOwned(dto.apiIds, tenantId) : undefined;

    try {
      const row = await prisma.product.update({
        where: { id },
        data: {
          name: dto.name,
          slug: dto.slug,
          description: dto.description,
          ...(apiIds
            ? { apis: { deleteMany: {}, create: apiIds.map((apiDefId) => ({ apiDefId })) } }
            : {}),
        },
        include: withApis,
      });
      return toDetail(row);
    } catch (err) {
      throw this.asConflict(err, dto.name ?? '', dto.slug ?? '');
    }
  }

  async remove(id: string, tenantId: string): Promise<{ message: string }> {
    const row = await this.findRow(id, tenantId);
    // ProductApi cascades from the product; the APIs themselves are untouched.
    await prisma.product.delete({ where: { id } });
    return { message: `Product "${row.name}" deleted.` };
  }

  /**
   * Cross-tenant guard. Without it a tenant could bundle another tenant's API by id and expose its
   * name and slug through its own product listing — the ids are uuids, but "unguessable" is not an
   * authorization check.
   */
  private async assertApisOwned(apiIds: string[], tenantId: string): Promise<string[]> {
    if (apiIds.length === 0) return [];

    const owned = await prisma.apiDefinition.findMany({
      where: { id: { in: apiIds }, tenantId },
      select: { id: true },
    });

    if (owned.length !== apiIds.length) {
      const ownedIds = new Set(owned.map((a) => a.id));
      const missing = apiIds.filter((id) => !ownedIds.has(id));
      throw new BadRequestException(
        `These API ids do not exist in this tenant: ${missing.join(', ')}`,
      );
    }
    return apiIds;
  }

  private async findRow(id: string, tenantId: string): Promise<ProductRow> {
    const row = await prisma.product.findFirst({ where: { id, tenantId }, include: withApis });
    if (!row) throw new NotFoundException(`Product ${id} not found`);
    return row;
  }

  private asConflict(err: unknown, name: string, slug: string): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // `meta.target` is the failing index's columns: a string, or an array of them.
      const rawTarget: unknown = err.meta?.target;
      const target = Array.isArray(rawTarget)
        ? rawTarget.join(',')
        : typeof rawTarget === 'string'
          ? rawTarget
          : '';
      return new ConflictException(
        target.includes('slug')
          ? `A product with slug "${slug}" already exists in this tenant.`
          : `A product named "${name}" already exists in this tenant.`,
      );
    }
    return err;
  }
}
