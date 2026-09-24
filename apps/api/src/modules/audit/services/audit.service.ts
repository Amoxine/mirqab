import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { prisma } from '@open-gateway/database';

export interface AuditEntry {
  tenantId?: string;
  userId?: string;
  action: AuditAction;
  resource: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  correlationId?: string;
}

export interface AuditFilters {
  dateFrom?: Date;
  /** Inclusive: the whole of that day is returned (see createdAtFilter). */
  dateTo?: Date;
  userId?: string;
  action?: string;
  resource?: string;
  page?: number;
  pageSize?: number;
}

/** A single CSV export stays a request, not a background job. Rows beyond this are cut. */
export const CSV_MAX_ROWS = 10_000;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Every read is scoped by tenant, and Prisma DROPS a `where` key whose value is `undefined` — a
 * tenant-less caller (anyone who signed up through POST /auth/register) would have read every
 * tenant's rows. Reject instead of querying.
 */
function requireTenant(tenantId: string | undefined): string {
  if (!tenantId) {
    throw new ForbiddenException('Access denied: no tenant context for this request');
  }
  return tenantId;
}

/** Start of the UTC day after `date`, i.e. the exclusive end of `date`'s day. */
const startOfNextUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));

/**
 * `dateFrom`/`dateTo` arrive as `YYYY-MM-DD` and the range is inclusive of both days. `lte: dateTo`
 * resolved to midnight, so asking for a single day returned nothing; the upper bound is the start of
 * the following day, exclusive.
 */
function createdAtFilter({ dateFrom, dateTo }: Pick<AuditFilters, 'dateFrom' | 'dateTo'>): {
  createdAt?: Prisma.DateTimeFilter;
} {
  if (!dateFrom && !dateTo) return {};

  return {
    createdAt: {
      ...(dateFrom ? { gte: dateFrom } : {}),
      ...(dateTo ? { lt: startOfNextUtcDay(dateTo) } : {}),
    },
  };
}

/** A value from a query string must not reach Prisma as an enum it would reject with a 500. */
const isAuditAction = (value: string | undefined): value is AuditAction =>
  value !== undefined && (Object.values(AuditAction) as string[]).includes(value);

/**
 * RFC4180 cell: always quoted, embedded quotes doubled.
 *
 * A cell starting with `=`, `+`, `-` or `@` is executed as a formula when the file is opened in
 * Excel or Sheets, so an attacker who gets a crafted string into an audited field (a resource name,
 * a user agent) could run it on whoever downloads the export. A leading apostrophe defuses it.
 */
export function csvCell(value: string | null | undefined): string {
  const raw = value ?? '';
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

const CSV_HEADER = [
  'Timestamp',
  'User',
  'Action',
  'Resource',
  'IP Address',
  'Correlation ID',
  'Details',
];

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  // Shared singleton from @open-gateway/database: `new PrismaClient()` here opened a second pool
  // that was never disconnected.
  private readonly prisma = prisma;

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.recordOrThrow(entry);
    } catch (error) {
      this.logger.error(`Failed to write audit log: ${(error as Error).message}`, (error as Error).stack);
    }
  }

  /**
   * As `record()`, but a write failure is the caller's problem, not swallowed here — for the rare
   * action where the audit entry IS the control, not a courtesy: `record()`'s own catch makes it
   * unsuitable there, since `await this.auditService.record(...)` always resolves even when the
   * insert failed, silently, which is exactly wrong for something like WP25's "adopt from gateway"
   * (P2) — an operator override to config of record that must not be able to report success while
   * going unaudited. Most callers want `record()`; reach for this only when a failed audit write
   * should fail the whole request.
   *
   * `tx` is an optional interactive-transaction client (`prisma.$transaction(async (tx) => ...)`) to
   * write through instead of the shared singleton — needed wherever the audit row and the change it
   * documents must commit or roll back together. WP25's own adopt-from-gateway is the reason this
   * parameter exists: live-verified (worker-8) that without it, a throwing audit write left the
   * `ApiDefinition` override persisted with zero trace it happened, which is exactly the un-audited
   * state P2's escape hatch exists to prevent.
   */
  async recordOrThrow(entry: AuditEntry, tx: Prisma.TransactionClient | typeof this.prisma = this.prisma): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: entry.tenantId ?? null,
        userId: entry.userId ?? null,
        action: entry.action,
        resource: entry.resource,
        // A nullable Json column needs Prisma's own null sentinel; plain `null` is not accepted.
        details: entry.details ? (entry.details as Prisma.InputJsonValue) : Prisma.DbNull,
        ipAddress: entry.ipAddress ?? null,
        corrId: entry.correlationId ?? null,
      },
    });
  }

  async findAll(tenantId: string | undefined, filters: AuditFilters = {}) {
    const { userId, action, resource } = filters;

    // Clamped here as well as in AuditQueryDto: page 0 produced a negative skip (Prisma 500) and
    // pageSize was unbounded, so one request could pull an entire tenant's history.
    const page = Math.max(1, Math.trunc(filters.page ?? 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.trunc(filters.pageSize ?? DEFAULT_PAGE_SIZE)),
    );

    const where: Prisma.AuditLogWhereInput = {
      tenantId: requireTenant(tenantId),
      ...createdAtFilter(filters),
      ...(userId ? { userId } : {}),
      ...(isAuditAction(action) ? { action } : {}),
      ...(resource ? { resource: { contains: resource } } : {}),
    };

    const [data, totalCount] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { name: true, email: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data,
      meta: {
        page,
        pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
      },
    };
  }

  async findOne(id: bigint, tenantId: string | undefined) {
    return this.prisma.auditLog.findUnique({
      where: { id, tenantId: requireTenant(tenantId) },
      include: { user: { select: { name: true, email: true } } },
    });
  }

  async exportCsv(
    tenantId: string | undefined,
    filters: Pick<AuditFilters, 'dateFrom' | 'dateTo'> = {},
  ): Promise<string> {
    const logs = await this.prisma.auditLog.findMany({
      where: {
        tenantId: requireTenant(tenantId),
        ...createdAtFilter(filters),
      },
      orderBy: { createdAt: 'desc' },
      take: CSV_MAX_ROWS,
      include: { user: { select: { name: true } } },
    });

    const rows = logs.map((log) => [
      log.createdAt.toISOString(),
      log.user?.name ?? 'System',
      log.action,
      log.resource,
      log.ipAddress ?? '',
      log.corrId ?? '',
      JSON.stringify(log.details ?? {}),
    ]);

    // CRLF: RFC4180's record separator.
    return [CSV_HEADER, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  }

  async getStats(tenantId: string | undefined, range = '30d') {
    const scopedTenantId = requireTenant(tenantId);
    const days = Number.parseInt(range, 10) || 30;
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - days);

    const where: Prisma.AuditLogWhereInput = { tenantId: scopedTenantId, createdAt: { gte: dateFrom } };

    const totalLogs = await this.prisma.auditLog.count({ where });

    const actionCounts = await this.prisma.auditLog.groupBy({
      by: ['action'],
      where,
      _count: { action: true },
    });
    const logsByAction: Record<string, number> = {};
    for (const ac of actionCounts) {
      logsByAction[ac.action] = ac._count.action;
    }

    const topUsers = await this.prisma.auditLog.groupBy({
      by: ['userId'],
      where,
      _count: { userId: true },
      orderBy: { _count: { userId: 'desc' } },
      take: 10,
    });

    const topResources = await this.prisma.auditLog.groupBy({
      by: ['resource'],
      where,
      _count: { resource: true },
      orderBy: { _count: { resource: 'desc' } },
      take: 10,
    });

    return {
      totalLogs,
      logsByAction,
      topUsers: topUsers.map((u) => ({ userId: u.userId, count: u._count.userId })),
      topResources: topResources.map((r) => ({ resource: r.resource, count: r._count.resource })),
    };
  }
}
