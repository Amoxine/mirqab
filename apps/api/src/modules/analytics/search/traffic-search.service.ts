import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type PrismaClient } from '@prisma/client';
import { TrafficSearchIndexerService } from './traffic-search.indexer.service';
import { queryWithTimeout, SearchTimeoutError } from './traffic-search.query';
import { trafficSearchQuery } from './traffic-search.query.builder';
import type { SearchCursor, SearchRange, TrafficSearchRequest } from './traffic-search.types';
import { isRowId, isRowTs, SearchValidationError, validateSearchRequest } from './traffic-search.validate';

export interface TrafficSearchItem {
  id: string;
  /** ISO-8601 UTC with microseconds: also the keyset cursor's timestamp. */
  ts: string;
  /** The `ApiDefinition` id, for linking to the API; `null` if the API was deleted since. */
  apiId: string | null;
  apiName: string | null;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  keyAlias: string;
  /** The body was cut at 16 KiB before it was indexed: a search only saw the part that was kept. */
  reqTruncated: boolean;
  resTruncated: boolean;
}

export interface TrafficSearchPage {
  range: SearchRange;
  items: TrafficSearchItem[];
  hasMore: boolean;
  nextCursor: SearchCursor | null;
  /** How far the indexer has caught up; an empty result before this instant is real, after it is not yet known. */
  indexedUntil: string | null;
}

export interface TrafficSearchDetail extends TrafficSearchItem {
  ip: string;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
  reqBody: string;
  resBody: string;
}

interface ListRow {
  id: bigint;
  ts_iso: string;
  apiid: string;
  method: string;
  path: string;
  status: number;
  latency_ms: number;
  key_alias: string;
  req_truncated: boolean;
  res_truncated: boolean;
}

interface DetailRow extends ListRow {
  ip: string;
  req_headers: Record<string, string>;
  res_headers: Record<string, string>;
  req_body: string;
  res_body: string;
}

const DEFAULT_TIMEOUT_MS = 3000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;
/** Searches one tenant may have running at once; each can hold a connection for the whole statement budget. */
const MAX_IN_FLIGHT_PER_TENANT = 2;

interface TenantApi {
  id: string;
  name: string;
  slug: string;
  tykApiId: string;
}

/**
 * The search endpoint's logic. The tenant boundary is here: Pump and projection rows carry no tenant,
 * only a Tyk API id, so the set of Tyk ids of the caller's own `ApiDefinition` rows IS the scope. It is
 * applied by `trafficSearchQuery` as its first predicate; `api:` clauses can only narrow within it.
 */
@Injectable()
export class TrafficSearchService {
  // ponytail: per-process count; move it to Redis if the API runs as more than one replica.
  private readonly inFlight = new Map<string, number>();

  constructor(
    @Inject('PRISMA_CLIENT') private readonly prisma: PrismaClient,
    private readonly configService: ConfigService,
    private readonly indexer: TrafficSearchIndexerService,
  ) {}

  async search(tenantId: string, body: unknown): Promise<TrafficSearchPage> {
    let request;
    try {
      request = validateSearchRequest(body);
    } catch (err) {
      if (err instanceof SearchValidationError) throw new BadRequestException({ error: 'SEARCH_INVALID', message: err.message });
      throw err;
    }

    const running = this.inFlight.get(tenantId) ?? 0;
    if (running >= MAX_IN_FLIGHT_PER_TENANT) {
      throw new HttpException(
        { error: 'SEARCH_BUSY', message: 'Too many searches are running for this tenant. Wait for one to finish and try again.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.inFlight.set(tenantId, running + 1);
    try {
      return await this.page(tenantId, request);
    } finally {
      const left = (this.inFlight.get(tenantId) ?? 1) - 1;
      if (left > 0) this.inFlight.set(tenantId, left);
      else this.inFlight.delete(tenantId);
    }
  }

  private async page(tenantId: string, request: TrafficSearchRequest): Promise<TrafficSearchPage> {
    const apis = await this.tenantApis(tenantId);
    const indexedUntil = (await this.indexer.indexedUntil().catch(() => null))?.toISOString() ?? null;
    if (apis.length === 0) return { range: request.range, items: [], hasMore: false, nextCursor: null, indexedUntil };

    const byTyk = new Map(apis.map((a) => [a.tykApiId, a]));
    const resolveApi = (value: string): string[] => {
      const wanted = value.toLowerCase();
      return apis.filter((a) => a.id === value || a.name.toLowerCase() === wanted || a.slug.toLowerCase() === wanted).map((a) => a.tykApiId);
    };

    const query = trafficSearchQuery({ request, tykApiIds: apis.map((a) => a.tykApiId), resolveApi });
    const rows = await this.run<ListRow[]>(query);
    const hasMore = rows.length > request.limit;
    const page = rows.slice(0, request.limit);
    const last = page.at(-1);

    return {
      range: request.range,
      items: page.map((r) => this.item(r, byTyk)),
      hasMore,
      nextCursor: hasMore && last ? { ts: last.ts_iso, id: String(last.id) } : null,
      indexedUntil,
    };
  }

  /** One row with its headers and bodies. `ts` is required: it is what lets Postgres open one partition. */
  async detail(tenantId: string, id: string, ts: string): Promise<TrafficSearchDetail> {
    if (!isRowId(id) || !isRowTs(ts)) {
      throw new BadRequestException({ error: 'SEARCH_INVALID', message: 'id and ts must come from a search result.' });
    }
    const apis = await this.tenantApis(tenantId);
    const byTyk = new Map(apis.map((a) => [a.tykApiId, a]));
    const rows =
      apis.length === 0
        ? []
        : await this.run<DetailRow[]>(Prisma.sql`
            SELECT id, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts_iso, apiid, method, path,
                   status, latency_ms, key_alias, ip, req_truncated, res_truncated,
                   req_headers, res_headers, req_body, res_body
              FROM public.og_traffic_search
             WHERE apiid = ANY(${apis.map((a) => a.tykApiId)}::text[])
               AND ts = ${ts}::timestamptz AND id = ${id}::bigint
             LIMIT 1`);
    const row = rows.at(0);
    // Another tenant's row, a row that aged out, and a row that never existed all answer the same way.
    if (!row) throw new NotFoundException('Captured request not found');
    return {
      ...this.item(row, byTyk),
      ip: row.ip,
      reqHeaders: row.req_headers,
      resHeaders: row.res_headers,
      reqBody: row.req_body,
      resBody: row.res_body,
    };
  }

  private item(row: ListRow, byTyk: Map<string, TenantApi>): TrafficSearchItem {
    const api = byTyk.get(row.apiid);
    return {
      id: String(row.id),
      ts: row.ts_iso,
      apiId: api?.id ?? null,
      apiName: api?.name ?? null,
      method: row.method,
      path: row.path,
      status: row.status,
      latencyMs: row.latency_ms,
      keyAlias: row.key_alias,
      reqTruncated: row.req_truncated,
      resTruncated: row.res_truncated,
    };
  }

  private async run<T>(query: Prisma.Sql): Promise<T> {
    try {
      return await queryWithTimeout<T>(this.prisma, query, this.timeoutMs());
    } catch (err) {
      if (err instanceof SearchTimeoutError) {
        throw new UnprocessableEntityException({
          error: 'SEARCH_TOO_BROAD',
          message: 'That search is too broad to finish in time. Add a status, an API or a shorter window, or use a more specific word.',
        });
      }
      throw err;
    }
  }

  private async tenantApis(tenantId: string): Promise<TenantApi[]> {
    const rows = await this.prisma.apiDefinition.findMany({
      where: { tenantId, tykApiId: { not: null } },
      select: { id: true, name: true, slug: true, tykApiId: true },
    });
    return rows.flatMap((r) => (r.tykApiId ? [{ id: r.id, name: r.name, slug: r.slug, tykApiId: r.tykApiId }] : []));
  }

  private timeoutMs(): number {
    const v = Number(this.configService.get<string>('TRAFFIC_SEARCH_TIMEOUT_MS'));
    return Number.isInteger(v) ? Math.min(Math.max(v, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  }
}
