import type { Prisma} from '@prisma/client';
import { type PrismaClient } from '@prisma/client';

/** A statement that ran past its budget. Mapped by the service to `422 SEARCH_TOO_BROAD`. */
export class SearchTimeoutError extends Error {}

/** Postgres reports a cancelled statement as SQLSTATE 57014; Prisma carries it in the message or in `meta`. */
function isTimeout(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  const meta = (err as { meta?: { code?: unknown } } | null)?.meta;
  return /statement timeout|canceling statement|57014/i.test(text) || meta?.code === '57014';
}

/**
 * Runs one read with a per-statement time budget. `SET LOCAL` lasts only for the surrounding transaction,
 * so the budget cannot leak onto another request's pooled connection.
 */
export async function queryWithTimeout<T>(prisma: PrismaClient, query: Prisma.Sql, timeoutMs: number): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      // `timeoutMs` is an integer the service clamped; it is bound nowhere else because SET cannot take a parameter.
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${String(Math.trunc(timeoutMs))}`);
      return tx.$queryRaw<T>(query);
    });
  } catch (err) {
    if (isTimeout(err)) throw new SearchTimeoutError('The search ran past its time budget.');
    throw err;
  }
}
