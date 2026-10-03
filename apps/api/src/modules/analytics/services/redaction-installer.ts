import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { isLockTimeout } from '../search/traffic-search.query';
import { resetProjection, TAG_PENDING } from '../search/traffic-search.state';
import { analyticsRedactionDdl } from './pump-query.builder';

const logger = new Logger('RedactionInstaller');

const FUNCTION = 'public.og_redact_http_dump(text,text)';
/** Rows are re-redacted in windows of this length: the window's row addresses are read in one short statement. */
const WINDOW_MS = 10 * 60_000;
/** Rows one UPDATE rewrites: a statement that holds its row locks for milliseconds however dense the window. */
export const BACKFILL_BATCH_ROWS = 200;
/** The trigger DDL gives up after 5 s on a lock (see `analyticsRedactionDdl`); try again this many times, this far apart. */
const LOCK_ATTEMPTS = 3;
const LOCK_RETRY_MS = 2000;

/**
 * A fingerprint of the SQL redaction rules: the hash of the very DDL that installs them, so any change to a
 * pattern, to the field list or to the trigger shows up here without anyone remembering to bump a number.
 * The parser's rules and the row builder's are versioned separately (`projectionTag`): they change what the
 * SEARCH TABLE holds, not what `tyk_analytics` holds, so they rebuild the table without rewriting the raw rows.
 */
export function redactionTag(fields: string[]): string {
  return `ddl:${createHash('sha256').update(analyticsRedactionDdl(fields)).digest('hex').slice(0, 16)}`;
}

/** `[from, to)` windows of `stepMs`, newest first, covering `[from, to)`. */
export function backfillWindows(from: Date, to: Date, stepMs: number = WINDOW_MS): [Date, Date][] {
  const out: [Date, Date][] = [];
  for (let end = to.getTime(); end > from.getTime(); end -= stepMs) {
    out.push([new Date(Math.max(end - stepMs, from.getTime())), new Date(end)]);
  }
  return out;
}

/** `items` in consecutive slices of at most `size`. */
export function inBatches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface RedactionInstall {
  /** The installed rules differed from these (or carried no tag): stored rows are being re-redacted. */
  upgrading: boolean;
  /**
   * Resolves when the re-redaction and the tag write are done (immediately when nothing needed fixing).
   * Callers need not wait for it: a boot should not block on rewriting a month of rows. Never rejects.
   */
  done: Promise<{ windows: number; rows: number }>;
}

const NOTHING = { windows: 0, rows: 0 };
const idle = (): RedactionInstall => ({ upgrading: false, done: Promise.resolve(NOTHING) });

let running: RedactionInstall | null = null;

/** Runs the install DDL; its trigger lock gives up after 5 s (a lock timeout), which is retried before it is an error. */
async function installDdl(prisma: PrismaClient, fields: string[]): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await prisma.$queryRawUnsafe(analyticsRedactionDdl(fields));
      return;
    } catch (err) {
      if (!isLockTimeout(err) || attempt >= LOCK_ATTEMPTS) throw err;
      logger.warn(`The pump holds tyk_analytics: the redaction trigger could not be installed yet (attempt ${String(attempt)}), retrying`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/**
 * Installs the redaction function and trigger and, when the rules are not the ones last applied to the
 * stored rows, re-redacts the retained captured rows and clears the search projection (which was built
 * from text the old rules let through). The install is awaited; the re-redaction continues in the
 * background (`done`).
 *
 * The version lives in the function's `COMMENT` and is written only after the backfill finished, so a
 * failed or interrupted backfill is retried on the next boot or daily run. Redaction is idempotent, so
 * re-running a window is harmless, and only the rows it changes are rewritten. The backfill updates rows
 * (row locks, in short batches), never the table lock the trigger DDL takes. One backfill at a time per process.
 *
 * A failed read of the installed version throws (it is not "first install"), after the trigger was installed anyway:
 * the caller logs it and the next boot or daily run tries again, instead of treating an unreadable catalog as
 * permission to skip the backfill.
 */
export async function ensureRedaction(prisma: PrismaClient, fields: string[], retentionDays: number, now: Date = new Date()): Promise<RedactionInstall> {
  if (running) {
    await installDdl(prisma, fields); // still keep the trigger installed
    return running;
  }
  const tag = redactionTag(fields);
  // Read before the DDL (a first install is "the function was not there"), but never instead of it: the trigger is
  // the safety, so an unreadable version is thrown only AFTER the trigger is in place, and writes no tag, so the next
  // boot or daily run looks again.
  let before: { present: boolean; tag: string | null } | undefined;
  let unreadable: unknown;
  try {
    before = await installedTag(prisma);
  } catch (err) {
    unreadable = err;
  }

  // Idempotent. When the trigger was missing it also redacts the stored rows in this same transaction.
  await installDdl(prisma, fields);
  if (before === undefined) throw unreadable;

  const after = await installedTag(prisma);
  if (!after.present || after.tag === tag) return idle(); // no table yet, or already current

  if (!before.present) {
    // A first install has nothing older to fix: the DDL redacted what was stored. Just record the version.
    await writeTag(prisma, tag);
    return idle();
  }

  const install: RedactionInstall = {
    upgrading: true,
    done: backfill(prisma, fields, retentionDays, now, tag).finally(() => {
      running = null;
    }),
  };
  running = install;
  return install;
}

/**
 * The installed rules' version. `present: false` ONLY when the function does not exist (a first install); a
 * query that fails throws, so an unreadable catalog can never pass for one.
 */
export async function installedTag(prisma: PrismaClient): Promise<{ present: boolean; tag: string | null }> {
  const rows = await prisma.$queryRaw<{ present: boolean; tag: string | null }[]>`
    SELECT to_regprocedure('public.og_redact_http_dump(text,text)') IS NOT NULL AS present,
           obj_description(to_regprocedure('public.og_redact_http_dump(text,text)'), 'pg_proc') AS tag`;
  return rows[0] ?? { present: false, tag: null };
}

/** `tag` is hex behind a fixed prefix, so it is safe as a literal (COMMENT cannot take a parameter). */
async function writeTag(prisma: PrismaClient, tag: string): Promise<void> {
  await prisma.$executeRawUnsafe(`COMMENT ON FUNCTION ${FUNCTION} IS '${tag}'`);
}

/**
 * Rewrites the dumps of `ids` (row addresses read a moment ago) that the function changes. The function runs once per
 * row, in a subquery, and the UPDATE joins on the address: a plain `SET x = f(x)` would rewrite rows it leaves
 * unchanged. `ctid = ANY(...)` is a Tid Scan, so the batch touches only its own pages.
 */
async function redactBatch(prisma: PrismaClient, fieldList: string, ids: string[]): Promise<number> {
  return prisma.$executeRaw`
    UPDATE public.tyk_analytics t
       SET rawrequest = r.rq, rawresponse = r.rs
      FROM (SELECT ctid AS id,
                   og_redact_http_dump(rawrequest, ${fieldList}) AS rq,
                   og_redact_http_dump(rawresponse, ${fieldList}) AS rs
              FROM public.tyk_analytics WHERE ctid = ANY(${ids}::text[]::tid[])) r
     WHERE t.ctid = r.id AND (t.rawrequest IS DISTINCT FROM r.rq OR t.rawresponse IS DISTINCT FROM r.rs)`;
}

async function backfill(prisma: PrismaClient, fields: string[], retentionDays: number, now: Date, tag: string): Promise<{ windows: number; rows: number }> {
  try {
    const fieldList = fields.join('|');
    const oldest = (
      await prisma.$queryRaw<{ ts: Date | null }[]>`
        SELECT min("timestamp") AS ts FROM public.tyk_analytics WHERE rawrequest <> '' OR rawresponse <> ''`
    )[0]?.ts;
    const floor = new Date(now.getTime() - retentionDays * 86_400_000);
    let windows = 0;
    let rows = 0;
    if (oldest) {
      for (const [from, to] of backfillWindows(oldest > floor ? oldest : floor, new Date(now.getTime() + 1000))) {
        const ids = await prisma.$queryRaw<{ id: string }[]>`
          SELECT ctid::text AS id FROM public.tyk_analytics
           WHERE (rawrequest <> '' OR rawresponse <> '') AND "timestamp" >= ${from} AND "timestamp" < ${to}`;
        // Bounded by rows, not by time: a window of a busy minute is as many short statements as it needs.
        for (const batch of inBatches(ids, BACKFILL_BATCH_ROWS)) {
          rows += await redactBatch(prisma, fieldList, batch.map((r) => r.id));
        }
        windows += 1;
      }
    }
    // What the search projection holds was derived under the old rules: empty it (generation raised, so a scan that
    // began before this cannot write into it afterwards) and let the indexer rebuild the whole retention window.
    await resetProjection(prisma, retentionDays, TAG_PENDING);
    await writeTag(prisma, tag);
    logger.warn(`Redaction rules changed: re-redacted ${String(rows)} stored row(s) in ${String(windows)} window(s) and reset the search projection`);
    return { windows, rows };
  } catch (err) {
    // The tag stays as it was, so the next boot or daily run tries again.
    logger.error(`Redaction backfill failed, will retry: ${err instanceof Error ? err.message : String(err)}`);
    return NOTHING;
  }
}
