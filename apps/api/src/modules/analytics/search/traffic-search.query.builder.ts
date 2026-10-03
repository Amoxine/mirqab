import { Prisma } from '@prisma/client';
import { analyticsWindow } from '../services/pump-query.builder';
import { escapeLike } from '../services/traffic-query.builder';
import { FULLTEXT_COLUMN, FULLTEXT_REQ, FULLTEXT_RES } from './traffic-search.sql';
import type { SearchClause, StatusMatch, TrafficSearchRequest } from './traffic-search.types';

/**
 * SQL for `POST /analytics/traffic/search`, against the `og_traffic_search` projection (one redacted
 * row per captured request, partitioned by day on `ts`). Pure: no database, so the tenant scope and
 * the parameter binding are unit-tested.
 *
 * Every value is a bound parameter. The only interpolated pieces are the fixed fragments below, picked
 * by `kind` from a closed union that `validateSearchRequest` has already enforced.
 *
 * The first two predicates are never optional and never come from a clause: the tenant's APIs
 * (`apiid = ANY(...)`) and the time window (`ts >= ...`, which is what lets Postgres skip the daily
 * partitions outside it).
 */

/** Columns the list needs; the two body columns stay in the table until a row is opened. */
const LIST_COLUMNS = Prisma.raw(
  `id, ts, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts_iso, apiid, method, path, status, latency_ms, key_alias, req_truncated, res_truncated`,
);

function compare(column: Prisma.Sql, op: string, value: number): Prisma.Sql {
  // `op` was checked against the four operators by the validator; it is still mapped, never pasted.
  switch (op) {
    case '>':
      return Prisma.sql`${column} > ${value}`;
    case '>=':
      return Prisma.sql`${column} >= ${value}`;
    case '<':
      return Prisma.sql`${column} < ${value}`;
    default:
      return Prisma.sql`${column} <= ${value}`;
  }
}

function status(match: StatusMatch): Prisma.Sql {
  if (match.type === 'cmp') return compare(Prisma.raw('status'), match.op, match.value);
  if (match.type === 'range') return Prisma.sql`status BETWEEN ${match.from} AND ${match.to}`;
  return Prisma.sql`status = ANY(${match.values}::int[])`;
}

function predicate(clause: SearchClause, resolveApi: (value: string) => string[]): Prisma.Sql {
  switch (clause.kind) {
    case 'status':
      return status(clause.match);
    case 'latency':
      return compare(Prisma.raw('latency_ms'), clause.op, clause.value);
    case 'method':
      return Prisma.sql`method = ANY(${clause.values}::text[])`;
    case 'path':
      return Prisma.sql`path LIKE ${`${escapeLike(clause.value)}%`} ESCAPE '\\'`;
    case 'route':
      // Bound as typed: `=` has no wildcards to escape. Like `path LIKE`, it filters the rows the (apiid, ts) index returns.
      return Prisma.sql`path = ${clause.value}`;
    case 'api':
      return Prisma.sql`apiid = ANY(${resolveApi(clause.value)}::text[])`;
    case 'key':
      return Prisma.sql`key_alias = ${clause.value}`;
    case 'header': {
      const column = Prisma.raw(clause.side === 'req' ? 'req_headers' : 'res_headers');
      // A header WITH a value is `@>`, which the `jsonb_path_ops` index serves (it hashes path + value): 6 ms for one
      // request id in 120k rows over 30 days. A header with no value is "does this key exist", which that index CANNOT
      // narrow, because it stores no bare keys: the planner reads the window's rows and filters (measured 120-350 ms for a
      // header no row has, at 120k rows; it scales with the rows the tenant and window leave, not with the header). That is
      // accepted rather than fixed: a `text[]` of header names with its own GIN index would serve it, at the cost of a
      // column and an index written for every captured request, for a clause that is rarely the only filter. Add it if
      // header-exists searches over a large window become common.
      return clause.value === undefined
        ? Prisma.sql`${column} @? ${`$."${clause.name}"`}::jsonpath`
        : Prisma.sql`${column} @> ${JSON.stringify({ [clause.name]: clause.value })}::jsonb`;
    }
    case 'body': {
      // The stored vector of both bodies is what the GIN index serves; a side-specific search adds an
      // exact recheck on that side so `req:` never matches a word that only the response contains.
      const any = Prisma.sql`${Prisma.raw(FULLTEXT_COLUMN)} @@ phraseto_tsquery('simple', ${clause.value})`;
      if (clause.side === 'any') return any;
      const side = Prisma.raw(clause.side === 'req' ? FULLTEXT_REQ : FULLTEXT_RES);
      return Prisma.sql`(${any} AND ${side} @@ phraseto_tsquery('simple', ${clause.value}))`;
    }
  }
}

export interface TrafficSearchQueryInput {
  request: TrafficSearchRequest;
  /** The caller's tenant's Tyk API ids: the tenant boundary. Empty means nothing can match. */
  tykApiIds: string[];
  /** Maps an `api:` value (name, slug or id) to that tenant's Tyk API ids; unknown names give `[]`. */
  resolveApi: (value: string) => string[];
  now?: Date;
}

/** One page plus one row, so "has more" needs no COUNT over the window. */
export function trafficSearchQuery({ request, tykApiIds, resolveApi, now }: TrafficSearchQueryInput): Prisma.Sql {
  const window = analyticsWindow(request.range, now);
  const where: Prisma.Sql[] = [Prisma.sql`apiid = ANY(${tykApiIds}::text[])`, Prisma.sql`ts >= ${window.from}`];

  for (const clause of request.clauses) {
    const sql = predicate(clause, resolveApi);
    // COALESCE: a NULL column (no JSON body, say) means "did not match", so a negated clause keeps the row.
    // Except a header clause on a capture that could not be read (`unredactable`): it has no headers because
    // none were read, not because none were sent, so "has no Authorization header" must not claim it.
    if (!clause.neg) where.push(sql);
    else if (clause.kind === 'header') where.push(Prisma.sql`(NOT COALESCE((${sql}), false) AND NOT unredactable)`);
    else where.push(Prisma.sql`NOT COALESCE((${sql}), false)`);
  }
  if (request.cursor) {
    // The cursor stays text: a JS Date would round its microseconds to milliseconds and skip or repeat rows at the page edge.
    where.push(Prisma.sql`(ts, id) < (${request.cursor.ts}::timestamptz, ${request.cursor.id}::bigint)`);
  }

  return Prisma.sql`
    SELECT ${LIST_COLUMNS}
    FROM public.og_traffic_search
    WHERE ${Prisma.join(where, ' AND ')}
    ORDER BY ts DESC, id DESC
    LIMIT ${request.limit + 1}
  `;
}
