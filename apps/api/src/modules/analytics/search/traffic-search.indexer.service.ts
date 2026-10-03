import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, type PrismaClient } from '@prisma/client';
import { recordJobRun, searchIndexedAgeSeconds, searchSkippedRowsTotal } from '../../../common/metrics/ops-metrics';
import { readConfig } from '../../api-management/services/tyk-mappers';
import { redactionTriggerQuery } from '../services/pump-query.builder';
import { installedTag } from '../services/redaction-installer';
import { addDays, utcDay } from './traffic-search.ddl';
import { BATCH_SIZE, capturedPageSql, type PageCursor } from './traffic-search.page-query';
import { isDataError, isMissingRelation, sqlState, withStatementTimeout } from './traffic-search.query';
import { buildSearchRow, type CapturedRow, type SearchRow } from './traffic-search.row';
import { FULLTEXT_ANY } from './traffic-search.sql';
import {
  changedAuthHeaders,
  commitProgress,
  projectionTag,
  readState,
  resetProjection,
  TAG_PENDING,
  unseenCustomAuthHeaders,
  type IndexState,
} from './traffic-search.state';
import { TrafficSearchStoreService } from './traffic-search.store.service';

/** Parsing is synchronous: give the event loop back after this long, whatever the rows cost (a hostile dump is 50-110 ms). */
const YIELD_AFTER_MS = 20;
/** One scan stops after this long and records how far it got; the next tick carries on. Bounds the CPU a backlog can take. */
const SCAN_BUDGET_MS = 8000;
/** No indexer statement may run longer than this: a page is milliseconds, and a stuck one must not hold a connection forever. */
const STATEMENT_TIMEOUT_MS = 30_000;
/** Each tick re-reads this far back: the pump can deliver a record late, and `tyk_analytics` has no id to resume from. */
const LOOKBACK_MS = 15 * 60_000;
/** The hourly pass reaches further back, for the records that arrive later still. */
const DEEP_LOOKBACK_MS = 6 * 3_600_000;
const DEFAULT_BACKFILL_DAYS = 7;
/** A missing table is reported by every tick; the upkeep that would create it is asked for this often at most. */
const MAINTAIN_EVERY_MS = 5 * 60_000;
/** Refused rows remembered so they are not retried every tick; bounded so a flood cannot grow it. */
const MAX_REFUSED = 10_000;

/** Why a scan returned what it did: a bare `0` used to mean any of these. */
export type ScanReason =
  /** Copied everything in the window. */
  | 'ok'
  /** Ran out of its time budget; progress was recorded and the next tick continues. */
  | 'budget'
  /** Another scan was still running. */
  | 'skipped-running'
  /** The redaction trigger is missing or disabled: nothing unredacted may be copied. */
  | 'paused'
  /** The search table (or the pump's) does not exist yet. */
  | 'table-missing'
  /** The table was reset while this scan ran (another process): what it wrote was discarded. */
  | 'superseded'
  /** Something failed; nothing was recorded, the next tick retries from the same point. */
  | 'error';

export interface ScanResult {
  inserted: number;
  /** Rows the search table refused and the scan left out so the rest could land. */
  skipped: number;
  reason: ScanReason;
}

const result = (reason: ScanReason, inserted = 0, skipped = 0): ScanResult => ({ inserted, skipped, reason });

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface Prepared {
  state: IndexState | null;
  authHeaders: Map<string, string | null>;
  tag: string;
}

/**
 * Copies captured requests from the pump's `tyk_analytics` into the search projection, redacted.
 *
 * Why polling with a lookback and not an id cursor: the pump table has no id, and the pump writes
 * batches that can land out of order. Each tick re-reads the last 15 minutes, skipping in SQL every row the
 * projection already holds (so only new rows are decoded and parsed), and inserts with
 * `ON CONFLICT (ts, dedupe_key) DO NOTHING` as a safety net, so a late row is still picked up.
 * The ceiling is a record delivered later than the hourly 6 h pass: it is never indexed. Dumps go
 * through `parseHttpDump` with each API's own auth header, the same pass the inspector displays with.
 *
 * What keeps it from hurting anyone else:
 *  - a page is read from the cursor on (`"timestamp" >= cursor`), not from the start of the window, so a
 *    backlog costs the same per page at the end as at the start;
 *  - every statement has a time budget, and so does a scan: it records how far it got and the next tick resumes,
 *    so a first run or a rebuild is a series of slices, not one scan that holds the `running` guard for hours;
 *  - parsing yields to the event loop by elapsed time, not row count;
 *  - a row Postgres refuses is found by halving its page, skipped, logged and counted, and the watermark moves on:
 *    one bad row can never freeze indexing for every tenant.
 *
 * Nothing here throws into the scheduler: a failed tick is logged and the next one tries again from the
 * same point, because the watermark only moves forward after a window was copied. A watermark that cannot be READ
 * skips the tick: it is not "no watermark", which would start a week-long backfill.
 */
@Injectable()
export class TrafficSearchIndexerService {
  private readonly logger = new Logger(TrafficSearchIndexerService.name);
  private running = false;
  private paused = false;
  private lastMaintainAt = 0;
  private readonly refused = new Set<string>();

  constructor(
    @Inject('PRISMA_CLIENT') private readonly prisma: PrismaClient,
    private readonly configService: ConfigService,
    private readonly store: TrafficSearchStoreService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async scheduledTick(): Promise<void> {
    const outcome = await this.tick();
    if (outcome.reason !== 'skipped-running') recordJobRun('search_index', outcome.reason !== 'error');
  }

  @Cron(CronExpression.EVERY_HOUR)
  async scheduledDeepPass(): Promise<void> {
    let to: Date;
    try {
      to = await this.dbNow();
    } catch (err) {
      this.logger.warn(`The hourly deep pass could not read the database clock: ${messageOf(err)}`);
      return;
    }
    const outcome = await this.scan(new Date(to.getTime() - DEEP_LOOKBACK_MS), to, false);
    if (outcome.reason === 'skipped-running') {
      this.logger.warn('The hourly deep pass was skipped: a scan was still running (the rows it would add are picked up by the next one)');
    } else if (outcome.reason === 'budget') {
      this.logger.warn('The hourly deep pass ran out of its time budget before it finished the last 6 hours');
    }
  }

  /** The latest instant the projection is known to cover, or `null` when nothing has been indexed. A failed read throws. */
  async indexedUntil(): Promise<Date | null> {
    return (await readState(this.prisma))?.scannedUntil ?? null;
  }

  /** The earliest instant the projection covers, or `null` when it covers nothing yet. A failed read throws. */
  async indexedFrom(): Promise<Date | null> {
    const state = await readState(this.prisma);
    if (!state) return null;
    if (state.indexedFrom) return state.indexedFrom;
    // A state row from before `indexed_from` existed: the oldest row held is the best statement of what it covers.
    const rows = await this.prisma.$queryRaw<{ ts: Date | null }[]>`SELECT min(ts) AS ts FROM public.og_traffic_search`;
    return rows[0]?.ts ?? null;
  }

  /** One incremental pass: from the watermark minus the lookback (or the backfill window on first run) to the database's now. */
  tick(now?: Date): Promise<ScanResult> {
    return this.exclusive(async () => {
      const to = now ?? (await this.dbNow());
      const state = await readState(this.prisma);
      if (state) searchIndexedAgeSeconds.set(Math.max(0, (to.getTime() - state.scannedUntil.getTime()) / 1000));
      const prepared = await this.prepare(state);
      if ('reason' in prepared) return prepared;
      const from = prepared.state
        ? new Date(prepared.state.scannedUntil.getTime() - LOOKBACK_MS)
        : addDays(to, -this.backfillDays());
      return this.scanWindow(from, to, true, prepared);
    });
  }

  /** Copies the captured rows in `[from, to)`. Serialised: a slow scan makes the next tick, and this, return `skipped-running`. */
  scan(from: Date, to: Date, advanceWatermark: boolean): Promise<ScanResult> {
    return this.exclusive(async () => {
      const prepared = await this.prepare(await readState(this.prisma));
      if ('reason' in prepared) return prepared;
      return this.scanWindow(from, to, advanceWatermark, prepared);
    });
  }

  private async exclusive(run: () => Promise<ScanResult>): Promise<ScanResult> {
    if (this.running) return result('skipped-running');
    this.running = true;
    try {
      return await run();
    } catch (err) {
      if (isMissingRelation(err)) {
        this.kickMaintenance();
        return result('table-missing');
      }
      this.logger.warn(`Traffic search indexing failed, will retry: ${messageOf(err)}`);
      return result('error');
    } finally {
      this.running = false;
    }
  }

  /**
   * Everything a scan needs to know first, or why it must not run: the trigger, the tables, and whether the rows
   * already in the table were built under rules that no longer hold (then it is emptied and rebuilt from the raw rows).
   */
  private async prepare(read: IndexState | null): Promise<Prepared | ScanResult> {
    if (!(await this.redactionTriggerPresent())) return result('paused');
    if (!(await this.tableExists())) {
      this.kickMaintenance();
      return result('table-missing');
    }
    const authHeaders = await this.authHeaderNames();
    const tag = projectionTag((await installedTag(this.prisma)).tag);

    let state = read;
    if (state) {
      const changed = changedAuthHeaders(state.authHeaders, authHeaders);
      // `pending-rebuild` is the installer's own reset: the table is already empty, nothing older is left to clear.
      const stale = state.redactionTag !== tag && state.redactionTag !== TAG_PENDING;
      // An API whose custom header was not known while its requests were indexed: those rows kept the header's value.
      const unseen = stale || changed.length > 0 ? [] : unseenCustomAuthHeaders(state.authHeaders, authHeaders);
      const exposed = unseen.length > 0 && (await this.hasIndexedRows(unseen));
      if (stale || changed.length > 0 || exposed) {
        this.logger.warn(
          stale
            ? 'The rules the search table was built under changed: rebuilding it from the retained captures'
            : changed.length > 0
              ? `The auth header of ${String(changed.length)} API(s) changed: rebuilding the search table from the retained captures`
              : `${String(unseen.length)} API(s) with their own auth header already had requests indexed before it was known: rebuilding the search table from the retained captures`,
        );
        await resetProjection(this.prisma, this.store.retentionDays(), tag, authHeaders);
        state = await readState(this.prisma);
      }
    }
    return { state, authHeaders, tag };
  }

  private async scanWindow(from: Date, to: Date, advance: boolean, { state, authHeaders, tag }: Prepared): Promise<ScanResult> {
    const generation = state?.generation ?? 0;
    const retentionFloor = addDays(utcDay(to), -this.store.retentionDays());
    const started = performance.now();
    let sliceStart = started;
    let inserted = 0;
    let skipped = 0;
    let reason: ScanReason = 'ok';
    let until = to.toISOString();
    let after: PageCursor | null = null;

    for (;;) {
      const page = await this.readPage(from, to, after);
      if (page.length === 0) break;
      const rows: SearchRow[] = [];
      for (const captured of page) {
        if (!this.refused.has(captured.dedupe_key)) {
          const row = buildSearchRow(captured, authHeaders.get(captured.apiid) ?? null);
          if (new Date(row.ts).getTime() >= retentionFloor.getTime()) rows.push(row);
        }
        if (performance.now() - sliceStart >= YIELD_AFTER_MS) {
          await yieldToEventLoop();
          sliceStart = performance.now();
        }
      }
      const written = await this.insertRows(rows, generation);
      inserted += written.inserted;
      skipped += written.skipped;
      const last = page.at(-1);
      if (!last) break;
      after = { ts: last.ts_iso, key: last.dedupe_key };
      if (page.length < BATCH_SIZE) break;
      if (performance.now() - started >= SCAN_BUDGET_MS) {
        reason = 'budget';
        until = last.ts_iso;
        break;
      }
    }

    if (advance && !(await commitProgress(this.prisma, { from, until, generation, tag, authHeaders }))) {
      // The table was emptied by another process while this scan ran: nothing it wrote is left, and it covers nothing.
      this.logger.warn('The search table was reset during a scan: its progress was discarded and the next tick starts the rebuild');
      reason = 'superseded';
    }
    return result(reason, inserted, skipped);
  }

  /** One keyset page of captured rows the projection does not hold yet: see `capturedPageSql` for why it stays cheap. */
  private readPage(from: Date, to: Date, after: PageCursor | null): Promise<CapturedRow[]> {
    return withStatementTimeout(this.prisma, STATEMENT_TIMEOUT_MS, (tx) => tx.$queryRaw<CapturedRow[]>(capturedPageSql(from, to, after)));
  }

  /** Inserts a page, finding a refused row by halving: see `insertBatch`. */
  private async insertRows(rows: SearchRow[], generation: number): Promise<{ inserted: number; skipped: number }> {
    if (rows.length === 0) return { inserted: 0, skipped: 0 };
    const days = new Map(rows.map((r) => [utcDay(new Date(r.ts)).getTime(), utcDay(new Date(r.ts))] as const));
    await this.store.ensurePartitions([...days.values()]);
    return this.insertHalving(rows, generation);
  }

  /**
   * One 500-row INSERT fails whole when Postgres refuses a single value in it (a NUL, a malformed escape), and every
   * tick would fail the same way for as long as the raw row exists. So a refused page is split in halves, down to single
   * rows; the row that is still refused alone is skipped, logged and counted, and the others land. Only errors that are
   * about a VALUE (`isDataError`) are split: a connection or a statement timeout would fail every half too, and is
   * thrown on so the tick fails and retries as before.
   */
  private async insertHalving(rows: SearchRow[], generation: number): Promise<{ inserted: number; skipped: number }> {
    try {
      return { inserted: await this.insertBatch(rows, generation), skipped: 0 };
    } catch (err) {
      if (!isDataError(err)) throw err;
      const only = rows.at(0);
      if (rows.length === 1 && only) {
        this.refuse(only.dedupeKey, err);
        return { inserted: 0, skipped: 1 };
      }
      const middle = Math.ceil(rows.length / 2);
      const left = await this.insertHalving(rows.slice(0, middle), generation);
      const right = await this.insertHalving(rows.slice(middle), generation);
      return { inserted: left.inserted + right.inserted, skipped: left.skipped + right.skipped };
    }
  }

  private refuse(dedupeKey: string, err: unknown): void {
    if (this.refused.size >= MAX_REFUSED) this.refused.clear();
    this.refused.add(dedupeKey);
    searchSkippedRowsTotal.inc();
    this.logger.warn(
      `Skipped a captured request the search table refused (dedupe_key ${dedupeKey}, SQLSTATE ${sqlState(err) ?? 'unknown'}): ${messageOf(err).slice(0, 300)}`,
    );
  }

  /**
   * The insert is conditional on the generation the scan started under: after a reset (TRUNCATE plus a raised generation, in
   * one transaction) a scan that began before it inserts nothing, instead of writing rows built under the old rules into
   * the emptied table.
   */
  private insertBatch(rows: SearchRow[], generation: number): Promise<number> {
    return withStatementTimeout(this.prisma, STATEMENT_TIMEOUT_MS, (tx) => tx.$executeRaw`
      INSERT INTO public.og_traffic_search
        (ts, apiid, method, path, status, latency_ms, key_alias, ip, req_headers, res_headers,
         req_body, res_body, req_truncated, res_truncated, unredactable, dedupe_key, fts)
      SELECT t.ts, t.apiid, t.method, t.path, t.status, t.latency_ms, t.key_alias, t.ip,
             t.req_headers::jsonb, t.res_headers::jsonb, t.req_body, t.res_body,
             t.req_truncated, t.res_truncated, t.unredactable, t.dedupe_key,
             ${Prisma.raw(FULLTEXT_ANY)}
        FROM unnest(
          ${rows.map((r) => r.ts)}::timestamptz[], ${rows.map((r) => r.apiid)}::text[],
          ${rows.map((r) => r.method)}::text[], ${rows.map((r) => r.path)}::text[],
          ${rows.map((r) => r.status)}::int[], ${rows.map((r) => r.latencyMs)}::int[],
          ${rows.map((r) => r.keyAlias)}::text[], ${rows.map((r) => r.ip)}::text[],
          ${rows.map((r) => JSON.stringify(r.reqHeaders))}::text[], ${rows.map((r) => JSON.stringify(r.resHeaders))}::text[],
          ${rows.map((r) => r.reqBody)}::text[], ${rows.map((r) => r.resBody)}::text[],
          ${rows.map((r) => r.reqTruncated)}::boolean[], ${rows.map((r) => r.resTruncated)}::boolean[],
          ${rows.map((r) => r.unredactable)}::boolean[], ${rows.map((r) => r.dedupeKey)}::text[]
        ) AS t(ts, apiid, method, path, status, latency_ms, key_alias, ip, req_headers, res_headers,
               req_body, res_body, req_truncated, res_truncated, unredactable, dedupe_key)
       WHERE COALESCE((SELECT generation FROM public.og_traffic_search_state WHERE id = 1), 0) = ${generation}::bigint
      ON CONFLICT (ts, dedupe_key) DO NOTHING`);
  }

  /** The database's clock, not this process's: the window and the watermark are compared with timestamps the database wrote. */
  private async dbNow(): Promise<Date> {
    const rows = await this.prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    return rows[0]?.now ?? new Date();
  }

  private async authHeaderNames(): Promise<Map<string, string | null>> {
    const apis = await this.prisma.apiDefinition.findMany({
      where: { tykApiId: { not: null } },
      select: { tykApiId: true, config: true },
    });
    const out = new Map<string, string | null>();
    for (const api of apis) if (api.tykApiId) out.set(api.tykApiId, readConfig(api.config).authHeaderName ?? null);
    return out;
  }

  /**
   * Whether the redaction trigger fires. Logged once when that changes, not every tick: a trigger that stays missing
   * overnight was 8,000 identical warnings.
   */
  private async redactionTriggerPresent(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ present: boolean }[]>(redactionTriggerQuery());
    const present = rows[0]?.present;
    if (!present && !this.paused) {
      this.logger.warn('Traffic search indexing paused: the redaction trigger is missing or disabled on tyk_analytics');
    } else if (present && this.paused) {
      this.logger.log('Traffic search indexing resumed: the redaction trigger is back');
    }
    this.paused = !present;
    return present;
  }

  /** Whether the search table already holds a row for any of these APIs: one indexed lookup per API, stopping at the first hit. */
  private async hasIndexedRows(apiIds: string[]): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM public.og_traffic_search WHERE apiid = ANY(${apiIds}::text[])) AS present`;
    return rows[0]?.present;
  }

  private async tableExists(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('public.og_traffic_search') IS NOT NULL AS present`;
    return rows[0]?.present;
  }

  /** Asks the table's upkeep to run, at most every few minutes: a missing table is not fixed by asking every 10 seconds. */
  private kickMaintenance(): void {
    const now = Date.now();
    if (now - this.lastMaintainAt < MAINTAIN_EVERY_MS) return;
    this.lastMaintainAt = now;
    void this.store.maintain();
  }

  /** How far back the very first scan reaches; never further than retention. */
  private backfillDays(): number {
    const v = Number(this.configService.get<string>('TRAFFIC_SEARCH_BACKFILL_DAYS'));
    return Math.min(Number.isInteger(v) && v > 0 ? v : DEFAULT_BACKFILL_DAYS, this.store.retentionDays());
  }
}
