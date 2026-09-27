import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { readConfig } from '../../api-management/services/tyk-mappers';
import type { AnalyticsRange } from '../dto/analytics-query.dto';
import { parseHttpDump, type HttpDump } from './http-dump-parser';
import { analyticsWindow, toNumber, type SqlNumeric } from './pump-query.builder';

export const TRAFFIC_DEFAULT_PAGE_SIZE = 20;
export const TRAFFIC_MAX_PAGE_SIZE = 50;
/** Keeps OFFSET small and a plain int: 1000 pages x 50 rows is already past any page anyone reads. */
const TRAFFIC_MAX_PAGE = 1000;

/**
 * Base64 characters read per dump column (~48 KB decoded): headers plus `MAX_BODY_CHARS` of body with
 * room to spare. Bounds what one page pulls into this process however large a captured body was.
 * `substr`, not `left`: Postgres can fetch just a slice of a TOASTed value for `substr`, `left`
 * detoasts the whole thing first.
 */
const RAW_FETCH_CHARS = 64 * 1024;

/** One captured request, redacted for display (`parseHttpDump`). */
export interface TrafficEntry {
  timestamp: string;
  method: string;
  path: string;
  responseCode: number;
  latencyMs: number;
  request: HttpDump | null;
  response: HttpDump | null;
}

/**
 * `NOT_ENABLED`: recording is off (or unset) AND nothing was ever captured for this API.
 * `FAILED`: the Pump table could not be read, or the redaction trigger is missing (then no row is
 * shown at all). Never folded into an empty page, which would say "no traffic" when the truth is
 * "don't know".
 * `OK`: captured rows in the window, newest first. May be empty, and may hold rows captured while
 * recording was on even though it is off now (`detailedRecording: false`).
 */
export type TrafficPage =
  | { status: 'NOT_ENABLED' }
  | { status: 'FAILED' }
  | {
      status: 'OK';
      detailedRecording: boolean;
      range: AnalyticsRange;
      page: number;
      pageSize: number;
      hasMore: boolean;
      items: TrafficEntry[];
    };

interface TrafficRow {
  ts: Date;
  method: string | null;
  path: string | null;
  responsecode: SqlNumeric;
  latency_total: SqlNumeric;
  rawrequest: string | null;
  rawrequest_clipped: boolean | null;
  rawresponse: string | null;
  rawresponse_clipped: boolean | null;
}

/**
 * "Captured" is a dump with content. Pump writes a row for EVERY request whatever the toggle says,
 * with both columns empty when recording is off, so "any row exists" would be true for any API that
 * ever saw traffic. A trigger placeholder (undecodable body) still counts: something was captured.
 * Keep it identical to the partial index predicate in `ANALYTICS_INDEX_DDL` (AC-LOG02.7): Postgres
 * only uses a partial index when the query's WHERE implies its predicate, and `A OR B` does not imply `A`.
 */
const CAPTURED = Prisma.sql`(rawrequest <> '' OR rawresponse <> '')`;

/** Window-free on purpose: rows captured long ago, while recording was on, still count. */
export function capturedExistsQuery(tykApiId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM public.tyk_analytics WHERE apiid = ${tykApiId} AND ${CAPTURED}
    ) AS captured
  `;
}

/** One page plus one row, so `hasMore` needs no COUNT over the window. */
export function trafficPageQuery(tykApiId: string, from: Date, limit: number, offset: number): Prisma.Sql {
  return Prisma.sql`
    SELECT "timestamp" AS ts, method, path, responsecode, latency_total,
           substr(rawrequest, 1, ${RAW_FETCH_CHARS}::int)      AS rawrequest,
           octet_length(rawrequest) > ${RAW_FETCH_CHARS}::int  AS rawrequest_clipped,
           substr(rawresponse, 1, ${RAW_FETCH_CHARS}::int)     AS rawresponse,
           octet_length(rawresponse) > ${RAW_FETCH_CHARS}::int AS rawresponse_clipped
    FROM public.tyk_analytics
    WHERE apiid = ${tykApiId}
      AND ${CAPTURED}
      AND "timestamp" >= ${from}
    ORDER BY "timestamp" DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

/** Must match the name `analyticsRedactionDdl` creates; the spec fails if the two drift apart. */
export const REDACTION_TRIGGER = 'og_redact_tyk_analytics_trg';

/**
 * Is the insert-time redaction trigger installed AND firing? It is created at API boot, and only if
 * `tyk_analytics` already exists; nothing makes the API wait for Pump, so it can be silently missing.
 * `tgenabled` 'O' and 'A' fire for Pump's ordinary sessions. 'D' is disabled, and 'R' fires only in
 * replica mode. `to_regclass` is NULL while the table is absent, so that case reads as "missing".
 */
export function redactionTriggerQuery(): Prisma.Sql {
  return Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = to_regclass('public.tyk_analytics')
        AND tgname = ${REDACTION_TRIGGER}
        AND tgenabled IN ('O', 'A')
    ) AS present
  `;
}

/**
 * Read path for `detailedRecording` (V1-LOG-02): the raw request/response dumps Pump stored for one
 * API, redacted a second time for display on top of the insert trigger.
 *
 * Deliberately not `AnalyticsService.safeQuery`: that turns a failed read into `[]`, which is right for
 * a dashboard counter and wrong here, where an empty list means "nothing captured".
 */
@Injectable()
export class TrafficInspectorService {
  private readonly logger = new Logger(TrafficInspectorService.name);

  constructor(@Inject('PRISMA_CLIENT') private readonly prisma: PrismaClient) {}

  /**
   * Takes the `ApiDefinition` id, never a Tyk api id: the Tyk id is resolved from a row scoped to
   * `tenantId`, and Pump rows carry no tenant, so this lookup IS the tenant boundary. Another
   * tenant's API answers 404, like every other `/apis/:id` route.
   */
  async list(
    tenantId: string,
    apiDefId: string,
    range: AnalyticsRange,
    page = 1,
    pageSize = TRAFFIC_DEFAULT_PAGE_SIZE,
  ): Promise<TrafficPage> {
    const api = await this.prisma.apiDefinition.findFirst({
      where: { id: apiDefId, tenantId },
      select: { tykApiId: true, config: true },
    });
    if (!api) throw new NotFoundException('API definition not found');

    const { detailedRecording, authHeaderName } = readConfig(api.config);
    const recording = detailedRecording === true;
    const { tykApiId } = api;
    const safePage = Math.min(Math.max(1, page), TRAFFIC_MAX_PAGE);
    const size = Math.min(Math.max(1, pageSize), TRAFFIC_MAX_PAGE_SIZE);

    try {
      // A never-synced API (no Tyk id) has no Pump rows to find.
      if (!recording && (tykApiId === null || !(await this.hasCaptured(tykApiId)))) {
        return { status: 'NOT_ENABLED' };
      }

      // Fail closed: without the trigger, Pump stored these dumps in full, and the parser's pass alone
      // is not the redaction this page promises. Checked on every call, no caching: it can be dropped.
      if (!(await this.redactionTriggerPresent())) {
        this.logger.warn(
          `Traffic for API ${apiDefId} withheld: ${REDACTION_TRIGGER} is missing or disabled on tyk_analytics`,
        );
        return { status: 'FAILED' };
      }

      const rows =
        tykApiId === null
          ? []
          : await this.prisma.$queryRaw<TrafficRow[]>(
              trafficPageQuery(tykApiId, analyticsWindow(range).from, size + 1, (safePage - 1) * size),
            );

      return {
        status: 'OK',
        detailedRecording: recording,
        range,
        page: safePage,
        pageSize: size,
        hasMore: rows.length > size,
        items: rows.slice(0, size).map((row) => ({
          timestamp: row.ts.toISOString(),
          method: row.method ?? '',
          path: row.path ?? '',
          responseCode: toNumber(row.responsecode),
          latencyMs: toNumber(row.latency_total),
          request: parseHttpDump(row.rawrequest, { authHeaderName, clipped: row.rawrequest_clipped === true }),
          response: parseHttpDump(row.rawresponse, { authHeaderName, clipped: row.rawresponse_clipped === true }),
        })),
      };
    } catch (err) {
      this.logger.warn(
        `Traffic read failed for API ${apiDefId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { status: 'FAILED' };
    }
  }

  private async hasCaptured(tykApiId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ captured: boolean }[]>(capturedExistsQuery(tykApiId));
    return rows.length > 0 && rows[0].captured;
  }

  private async redactionTriggerPresent(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ present: boolean }[]>(redactionTriggerQuery());
    return rows.length > 0 && rows[0].present;
  }
}
