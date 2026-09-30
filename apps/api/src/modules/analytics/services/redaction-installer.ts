import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { analyticsRedactionDdl } from './pump-query.builder';

const logger = new Logger('RedactionInstaller');

const FUNCTION = 'public.og_redact_http_dump(text,text)';
/** Rows are re-redacted in windows of this length: short statements, row locks only, the pump keeps inserting. */
const WINDOW_MS = 10 * 60_000;

/**
 * A fingerprint of the redaction rules: the hash of the very DDL that installs them, so any change to a
 * pattern, to the field list or to the trigger shows up here without anyone remembering to bump a number.
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

/**
 * Installs the redaction function and trigger and, when the rules are not the ones last applied to the
 * stored rows, re-redacts the retained captured rows and clears the search projection (which was built
 * from text the old rules let through). The install is awaited; the re-redaction continues in the
 * background (`done`).
 *
 * The version lives in the function's `COMMENT` and is written only after the backfill finished, so a
 * failed or interrupted backfill is retried on the next boot or daily run. Redaction is idempotent, so
 * re-running a window is harmless. The backfill updates rows (row locks, in short windows), never the
 * table lock the trigger DDL takes. One backfill at a time per process.
 */
export async function ensureRedaction(prisma: PrismaClient, fields: string[], retentionDays: number, now: Date = new Date()): Promise<RedactionInstall> {
  if (running) {
    await prisma.$queryRawUnsafe(analyticsRedactionDdl(fields)); // still keep the trigger installed
    return running;
  }
  const tag = redactionTag(fields);
  const before = await installedTag(prisma);

  // Idempotent. When the trigger was missing it also redacts the stored rows in this same transaction.
  await prisma.$queryRawUnsafe(analyticsRedactionDdl(fields));

  const after = await installedTag(prisma);
  if (after === null || !after.present || after.tag === tag) return idle(); // no table yet, or already current

  if (before?.present !== true) {
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

async function installedTag(prisma: PrismaClient): Promise<{ present: boolean; tag: string | null } | null> {
  try {
    const rows = await prisma.$queryRaw<{ present: boolean; tag: string | null }[]>`
      SELECT to_regprocedure('public.og_redact_http_dump(text,text)') IS NOT NULL AS present,
             obj_description(to_regprocedure('public.og_redact_http_dump(text,text)'), 'pg_proc') AS tag`;
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/** `tag` is hex behind a fixed prefix, so it is safe as a literal (COMMENT cannot take a parameter). */
async function writeTag(prisma: PrismaClient, tag: string): Promise<void> {
  await prisma.$executeRawUnsafe(`COMMENT ON FUNCTION ${FUNCTION} IS '${tag}'`);
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
        rows += await prisma.$executeRaw`
          UPDATE public.tyk_analytics
             SET rawrequest = og_redact_http_dump(rawrequest, ${fieldList}),
                 rawresponse = og_redact_http_dump(rawresponse, ${fieldList})
           WHERE (rawrequest <> '' OR rawresponse <> '') AND "timestamp" >= ${from} AND "timestamp" < ${to}`;
        windows += 1;
      }
    }
    // What the search projection holds was derived under the old rules: drop it, the indexer rebuilds it.
    await prisma.$executeRawUnsafe(`DO $$ BEGIN
      IF to_regclass('public.og_traffic_search') IS NOT NULL THEN
        TRUNCATE public.og_traffic_search;
        DELETE FROM public.og_traffic_search_state;
      END IF;
    END $$`);
    await writeTag(prisma, tag);
    logger.warn(`Redaction rules changed: re-redacted ${String(rows)} stored row(s) in ${String(windows)} window(s) and reset the search projection`);
    return { windows, rows };
  } catch (err) {
    // The tag stays as it was, so the next boot or daily run tries again.
    logger.error(`Redaction backfill failed, will retry: ${err instanceof Error ? err.message : String(err)}`);
    return NOTHING;
  }
}
