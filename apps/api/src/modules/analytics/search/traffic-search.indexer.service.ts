import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, type PrismaClient } from '@prisma/client';
import { readConfig } from '../../api-management/services/tyk-mappers';
import { redactionTriggerQuery } from '../services/pump-query.builder';
import { addDays, utcDay } from './traffic-search.ddl';
import { buildSearchRow, type CapturedRow, type SearchRow } from './traffic-search.row';
import { TrafficSearchStoreService } from './traffic-search.store.service';

const BATCH_SIZE = 500;
/** Each tick re-reads this far back: the pump can deliver a record late, and `tyk_analytics` has no id to resume from. */
const LOOKBACK_MS = 15 * 60_000;
/** The hourly pass reaches further back, for the records that arrive later still. */
const DEEP_LOOKBACK_MS = 6 * 3_600_000;
const DEFAULT_BACKFILL_DAYS = 7;
const DEFAULT_RETENTION_DAYS = 30;

/**
 * Copies captured requests from the pump's `tyk_analytics` into the search projection, redacted.
 *
 * Why polling with a lookback and not an id cursor: the pump table has no id, and the pump writes
 * batches that can land out of order. Each tick re-reads the last 15 minutes and inserts with
 * `ON CONFLICT (ts, dedupe_key) DO NOTHING`, so re-reading is free and a late row is still picked up.
 * The ceiling is a record delivered later than the hourly 6 h pass: it is never indexed. Dumps go
 * through `parseHttpDump` with each API's own auth header, the same pass the inspector displays with.
 *
 * Nothing here throws into the scheduler: a failed tick is logged and the next one tries again from the
 * same point, because the watermark only moves forward after a window was fully copied.
 */
@Injectable()
export class TrafficSearchIndexerService {
  private readonly logger = new Logger(TrafficSearchIndexerService.name);
  private running = false;

  constructor(
    @Inject('PRISMA_CLIENT') private readonly prisma: PrismaClient,
    private readonly configService: ConfigService,
    private readonly store: TrafficSearchStoreService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async scheduledTick(): Promise<void> {
    await this.tick();
  }

  @Cron(CronExpression.EVERY_HOUR)
  async scheduledDeepPass(): Promise<void> {
    await this.scan(new Date(Date.now() - DEEP_LOOKBACK_MS), new Date(), false);
  }

  /** The latest instant the projection is known to cover, or `null` before the first scan. */
  async indexedUntil(): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<{ scanned_until: Date }[]>`
      SELECT scanned_until FROM public.og_traffic_search_state WHERE id = 1`;
    return rows[0]?.scanned_until ?? null;
  }

  /** One incremental pass: from the watermark minus the lookback (or the backfill window on first run) to now. */
  async tick(now: Date = new Date()): Promise<number> {
    const watermark = await this.safe(() => this.indexedUntil(), null);
    const from = watermark
      ? new Date(watermark.getTime() - LOOKBACK_MS)
      : addDays(now, -this.backfillDays());
    return this.scan(from, now, true);
  }

  /** Copies the captured rows in `[from, to)`; returns how many it inserted. Serialised: a slow scan skips the next tick. */
  async scan(from: Date, to: Date, advanceWatermark: boolean): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      if (!(await this.redactionTriggerPresent())) {
        this.logger.warn('Traffic search indexing paused: the redaction trigger is missing or disabled on tyk_analytics');
        return 0;
      }
      if (!((await this.prisma.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('public.og_traffic_search') IS NOT NULL AS present`)[0]?.present)) return 0;

      const authHeaders = await this.authHeaderNames();
      const retentionFloor = addDays(utcDay(to), -this.retentionDays());
      let inserted = 0;
      let after: { ts: string; key: string } | null = null;

      for (;;) {
        const page: CapturedRow[] = await this.readPage(from, to, after);
        if (page.length === 0) break;
        const rows = page
          .map((r) => buildSearchRow(r, authHeaders.get(r.apiid) ?? null))
          .filter((r) => new Date(r.ts).getTime() >= retentionFloor.getTime());
        inserted += await this.insert(rows);
        const last = page[page.length - 1];
        after = { ts: last.ts_iso, key: last.dedupe_key };
        if (page.length < BATCH_SIZE) break;
      }

      if (advanceWatermark) await this.setWatermark(to);
      return inserted;
    } catch (err) {
      this.logger.warn(`Traffic search indexing failed, will retry: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** Keyset page over `(timestamp, dedupe_key)`: ties on the timestamp are ordered by the hash, so no row is skipped or repeated. */
  private readPage(from: Date, to: Date, after: { ts: string; key: string } | null): Promise<CapturedRow[]> {
    const cursor = after
      ? Prisma.sql`AND ("timestamp", dedupe_key) > (${after.ts}::timestamptz, ${after.key})`
      : Prisma.empty;
    return this.prisma.$queryRaw<CapturedRow[]>(Prisma.sql`
      SELECT * FROM (
        SELECT to_char("timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts_iso,
               "timestamp", apiid, apikey, alias, ipaddress, method, path, responsecode, latency_total,
               rawrequest, rawresponse,
               encode(sha256(convert_to(concat_ws('|', apiid,
                 to_char("timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
                 apikey, method, path, responsecode, latency_total, requesttime), 'UTF8')), 'hex') AS dedupe_key
          FROM public.tyk_analytics
         WHERE (rawrequest <> '' OR rawresponse <> '')
           AND "timestamp" >= ${from} AND "timestamp" < ${to}
      ) captured
      WHERE true ${cursor}
      ORDER BY "timestamp", dedupe_key
      LIMIT ${BATCH_SIZE}
    `);
  }

  private async insert(rows: SearchRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const days = new Map(rows.map((r) => [utcDay(new Date(r.ts)).getTime(), utcDay(new Date(r.ts))]));
    await this.store.ensurePartitions([...days.values()]);
    return this.prisma.$executeRaw`
      INSERT INTO public.og_traffic_search
        (ts, apiid, method, path, status, latency_ms, key_alias, ip, req_headers, res_headers,
         req_body, res_body, req_truncated, res_truncated, dedupe_key)
      SELECT t.ts, t.apiid, t.method, t.path, t.status, t.latency_ms, t.key_alias, t.ip,
             t.req_headers::jsonb, t.res_headers::jsonb, t.req_body, t.res_body,
             t.req_truncated, t.res_truncated, t.dedupe_key
        FROM unnest(
          ${rows.map((r) => r.ts)}::timestamptz[], ${rows.map((r) => r.apiid)}::text[],
          ${rows.map((r) => r.method)}::text[], ${rows.map((r) => r.path)}::text[],
          ${rows.map((r) => r.status)}::int[], ${rows.map((r) => r.latencyMs)}::int[],
          ${rows.map((r) => r.keyAlias)}::text[], ${rows.map((r) => r.ip)}::text[],
          ${rows.map((r) => JSON.stringify(r.reqHeaders))}::text[], ${rows.map((r) => JSON.stringify(r.resHeaders))}::text[],
          ${rows.map((r) => r.reqBody)}::text[], ${rows.map((r) => r.resBody)}::text[],
          ${rows.map((r) => r.reqTruncated)}::boolean[], ${rows.map((r) => r.resTruncated)}::boolean[],
          ${rows.map((r) => r.dedupeKey)}::text[]
        ) AS t(ts, apiid, method, path, status, latency_ms, key_alias, ip, req_headers, res_headers,
               req_body, res_body, req_truncated, res_truncated, dedupe_key)
      ON CONFLICT (ts, dedupe_key) DO NOTHING`;
  }

  private async setWatermark(to: Date): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO public.og_traffic_search_state (id, scanned_until) VALUES (1, ${to})
      ON CONFLICT (id) DO UPDATE SET scanned_until = GREATEST(public.og_traffic_search_state.scanned_until, EXCLUDED.scanned_until)`;
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

  private async redactionTriggerPresent(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ present: boolean }[]>(redactionTriggerQuery());
    return rows[0]?.present;
  }

  private async safe<T>(run: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await run();
    } catch {
      return fallback;
    }
  }

  private positive(key: string, fallback: number): number {
    const v = Number(this.configService.get<string>(key));
    return Number.isInteger(v) && v > 0 ? v : fallback;
  }

  private retentionDays(): number {
    return this.positive('ANALYTICS_RETENTION_DAYS', DEFAULT_RETENTION_DAYS);
  }

  /** How far back the very first scan reaches; never further than retention. */
  private backfillDays(): number {
    return Math.min(this.positive('TRAFFIC_SEARCH_BACKFILL_DAYS', DEFAULT_BACKFILL_DAYS), this.retentionDays());
  }
}
