import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { parserRulesFingerprint } from '../services/http-dump-parser';


/**
 * Bump when `buildSearchRow` stores something differently (a placeholder, a column, which bodies are kept)
 * or the dedupe key changes: rows built the old way stay in the table until the tag makes the indexer
 * rebuild it. 2: opaque bodies hidden, `unredactable`, the dedupe key as a JSON array. 3: the stored `fts` column.
 */
export const PROJECTION_RULES_VERSION = 3;

/**
 * Written by the redaction installer when it clears the table itself: the table is empty and nothing under
 * the old rules is left, so the indexer adopts its own tag instead of clearing it a second time.
 */
export const TAG_PENDING = 'pending-rebuild';

/** What the rows of the table were built under. Everything that can make an old row wrong is in here. */
export function projectionTag(ddlTag: string | null): string {
  const parts = [ddlTag ?? 'none', parserRulesFingerprint(), String(PROJECTION_RULES_VERSION)];
  return `proj:${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)}`;
}

/** The APIs whose auth header changed since the rows were built. A new or a deleted API is not a change: it has no old rows to fix. */
export function changedAuthHeaders(known: Record<string, string | null>, current: Map<string, string | null>): string[] {
  const changed: string[] = [];
  for (const [apiId, name] of current) {
    if (!Object.hasOwn(known, apiId)) continue;
    if ((known[apiId] ?? null)?.toLowerCase() !== name?.toLowerCase()) changed.push(apiId);
  }
  return changed;
}

/**
 * The APIs with a custom auth header that the recorded headers do not list at all. `changedAuthHeaders` leaves them alone
 * because a new API has no old rows, but one can: requests are indexed for an API id before its definition (and so its header
 * name) is known to the dashboard, and a deleted and re-created API is forgotten in between. Those rows were redacted
 * without the custom header, so whether any exist decides if the table must be rebuilt. An API on the default header was
 * always redacted by the default rules, so it never needs this.
 */
export function unseenCustomAuthHeaders(known: Record<string, string | null>, current: Map<string, string | null>): string[] {
  const unseen: string[] = [];
  for (const [apiId, name] of current) if (name && !Object.hasOwn(known, apiId)) unseen.push(apiId);
  return unseen;
}

export interface IndexState {
  scannedUntil: Date;
  indexedFrom: Date | null;
  generation: number;
  redactionTag: string | null;
  authHeaders: Record<string, string | null>;
}

interface StateRow {
  scanned_until: Date;
  indexed_from: Date | null;
  generation: bigint;
  redaction_tag: string | null;
  auth_headers: Record<string, string | null>;
}

/** The state row, or `null` when there is none yet (nothing indexed). A failed read throws: it is not "no row". */
export async function readState(db: Pick<PrismaClient, '$queryRaw'>): Promise<IndexState | null> {
  const rows = await db.$queryRaw<StateRow[]>`
    SELECT scanned_until, indexed_from, generation, redaction_tag, auth_headers
      FROM public.og_traffic_search_state WHERE id = 1`;
  const row = rows.at(0);
  if (!row) return null;
  return {
    scannedUntil: row.scanned_until,
    indexedFrom: row.indexed_from,
    generation: Number(row.generation),
    redactionTag: row.redaction_tag,
    authHeaders: row.auth_headers,
  };
}

export interface Progress {
  /** Where this scan began: the table now covers at least from here. */
  from: Date;
  /** Up to where it copied: an ISO string keeps the microseconds of the last row, a `Date` would round them. */
  until: string;
  /** The generation the scan started under. */
  generation: number;
  tag: string;
  authHeaders: Map<string, string | null>;
}

/**
 * Records that the table covers `[from, until]`. Only while the generation is still the one the scan started
 * under: a reset in between emptied the table, and the progress of a scan that wrote into the old one must not
 * claim coverage of the new one. Returns whether it was recorded.
 */
export async function commitProgress(db: Pick<PrismaClient, '$executeRaw'>, progress: Progress): Promise<boolean> {
  const headers = JSON.stringify(Object.fromEntries(progress.authHeaders));
  const changed = await db.$executeRaw`
    INSERT INTO public.og_traffic_search_state AS s (id, scanned_until, indexed_from, generation, redaction_tag, auth_headers)
    VALUES (1, ${progress.until}::timestamptz, ${progress.from}, ${progress.generation}::bigint, ${progress.tag}, ${headers}::jsonb)
    ON CONFLICT (id) DO UPDATE SET
      scanned_until = GREATEST(s.scanned_until, EXCLUDED.scanned_until),
      indexed_from = CASE WHEN s.indexed_from IS NULL THEN EXCLUDED.indexed_from ELSE LEAST(s.indexed_from, EXCLUDED.indexed_from) END,
      redaction_tag = EXCLUDED.redaction_tag,
      auth_headers = EXCLUDED.auth_headers
    WHERE s.generation = EXCLUDED.generation`;
  return changed > 0;
}

/**
 * Empties the table and starts the next rebuild at the retention floor: the raw rows are still the source, so
 * what the table covered is rebuilt for the WHOLE window they are kept for, not just the first-run backfill.
 * `indexed_from` is cleared (nothing is covered yet) and the generation is raised, in the same transaction as the
 * TRUNCATE: a scan that read the old generation can no longer insert or record progress.
 *
 * Does nothing when the state table is not there: no scan has run, so there is nothing derived to clear.
 */
export async function resetProjection(
  prisma: PrismaClient,
  retentionDays: number,
  tag: string,
  authHeaders = new Map<string, string | null>(),
): Promise<void> {
  const headers = JSON.stringify(Object.fromEntries(authHeaders));
  await prisma.$transaction(
    async (tx) => {
      const present = await tx.$queryRaw<{ state: boolean; rows: boolean }[]>`
        SELECT to_regclass('public.og_traffic_search_state') IS NOT NULL AS state,
               to_regclass('public.og_traffic_search') IS NOT NULL AS rows`;
      if (!present[0]?.state) return;
      // A lock the TRUNCATE cannot get quickly is a search or a scan in flight: say so rather than queue every reader behind it.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '10s'`);
      if (present[0].rows) await tx.$executeRawUnsafe('TRUNCATE public.og_traffic_search');
      await tx.$executeRaw`
        INSERT INTO public.og_traffic_search_state AS s (id, scanned_until, indexed_from, generation, redaction_tag, auth_headers)
        VALUES (1, now() - make_interval(days => ${retentionDays}::int), NULL, 1, ${tag}, ${headers}::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          generation = s.generation + 1,
          scanned_until = EXCLUDED.scanned_until,
          indexed_from = NULL,
          redaction_tag = EXCLUDED.redaction_tag,
          auth_headers = EXCLUDED.auth_headers`;
    },
    { maxWait: 5000, timeout: 60_000 },
  );
}
