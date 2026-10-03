import type { Prisma, PrismaClient } from '@prisma/client';

/** A statement that ran past its budget. Mapped by the service to `422 SEARCH_TOO_BROAD`. */
export class SearchTimeoutError extends Error {}

/**
 * The five-character SQLSTATE of a failed statement. Prisma carries it in `meta.code` for a raw query
 * (`P2010`), and in the message as ``Code: `22021` ``; a plain `Error` from a driver or a test may have either.
 */
export function sqlState(err: unknown): string | null {
  const meta = (err as { meta?: { code?: unknown } } | null)?.meta;
  if (typeof meta?.code === 'string' && /^[0-9A-Z]{5}$/.test(meta.code)) return meta.code;
  const text = err instanceof Error ? err.message : String(err);
  return /Code: `([0-9A-Z]{5})`/.exec(text)?.[1] ?? null;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Postgres reports a cancelled statement as SQLSTATE 57014; Prisma carries it in the message or in `meta`. */
function isTimeout(err: unknown): boolean {
  return /statement timeout|canceling statement|57014/i.test(messageOf(err)) || sqlState(err) === '57014';
}

/** `42P01`: a table that is not there (yet): the search tables are created at boot, and the pump creates its own late. */
export function isMissingRelation(err: unknown): boolean {
  return sqlState(err) === '42P01' || /relation "[^"]+" does not exist/i.test(messageOf(err));
}

/** `55P03`: a lock that was not granted within `lock_timeout`. */
export function isLockTimeout(err: unknown): boolean {
  return sqlState(err) === '55P03' || /lock timeout|could not obtain lock/i.test(messageOf(err));
}

/**
 * A value Postgres refused, as opposed to a connection or a statement that failed: SQLSTATE class 22 (data
 * exception: a NUL, a bad escape, malformed JSON) or 54 (program limit: a tsvector over 1 MB). Retrying the
 * same rows cannot succeed, retrying the others without the culprit can.
 */
export function isDataError(err: unknown): boolean {
  const state = sqlState(err);
  if (state !== null) return state.startsWith('22') || state.startsWith('54');
  return /invalid byte sequence|unsupported Unicode escape|invalid input syntax|string is too long for tsvector|cannot be converted to text/i.test(
    messageOf(err),
  );
}

/**
 * Runs `run` in a transaction whose statements are cancelled after `timeoutMs`. `SET LOCAL` lasts only for the
 * transaction, so the budget cannot leak onto another request's pooled connection. Prisma's own defaults (2 s to
 * get a connection, 5 s for the transaction) would cut a budget over 5 s short, and let a caller queue for a busy
 * pool longer than the work itself may run.
 */
export function withStatementTimeout<T>(
  prisma: PrismaClient,
  timeoutMs: number,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      // `timeoutMs` is an integer the caller clamped; it is bound nowhere else because SET cannot take a parameter.
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${String(Math.trunc(timeoutMs))}`);
      return run(tx);
    },
    { maxWait: 1000, timeout: timeoutMs + 1000 },
  );
}

/** Runs one read with a per-statement time budget; a statement that runs past it is a `SearchTimeoutError`. */
export async function queryWithTimeout<T>(prisma: PrismaClient, query: Prisma.Sql, timeoutMs: number): Promise<T> {
  try {
    return await withStatementTimeout(prisma, timeoutMs, (tx) => tx.$queryRaw<T>(query));
  } catch (err) {
    if (isTimeout(err)) throw new SearchTimeoutError('The search ran past its time budget.');
    throw err;
  }
}
