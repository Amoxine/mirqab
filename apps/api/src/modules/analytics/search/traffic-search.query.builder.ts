import { Prisma } from '@prisma/client';
import { analyticsWindow } from '../services/pump-query.builder';
import { escapeLike } from '../services/traffic-query.builder';
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
  'id, ts, apiid, method, path, status, latency_ms, key_alias, req_truncated, res_truncated',
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
  const column = Prisma.raw('status');
  if (match.type === 'cmp') return compare(column, match.op, match.value);
  if (match.type === 'range') return Prisma.sql`status BETWEEN ${match.from} AND ${match.to}`;
  return Prisma.sql`status = ANY(${match.values}::int[])`;
}

/** Both candidate encodings of one JSON leaf: the bare text may be a JSON string or a number. */
function jsonProbes(path: string[], value: string): [string, string] {
  const nest = (leaf: unknown) => JSON.stringify(path.reduceRight((inner, key) => ({ [key]: inner }), leaf));
  const asNumber = /^-?\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : value;
  return [nest(value), nest(asNumber)];
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
      return clause.mode === 'prefix'
        ? Prisma.sql`path LIKE ${`${escapeLike(clause.value)}%`} ESCAPE '\\'`
        : Prisma.sql`path ILIKE ${escapeLike(clause.value).replace(/\*/g, '%')} ESCAPE '\\'`;
    case 'api':
      return Prisma.sql`apiid = ANY(${resolveApi(clause.value)}::text[])`;
    case 'key':
      return Prisma.sql`key_alias = ${clause.value}`;
    case 'header': {
      const column = Prisma.raw(clause.side === 'req' ? 'req_headers' : 'res_headers');
      // `@?` and `@>` are the operators a jsonb_path_ops index serves; `?` (exists) is not.
      return clause.value === undefined
        ? Prisma.sql`${column} @? ${`$."${clause.name}"`}::jsonpath`
        : Prisma.sql`${column} @> ${JSON.stringify({ [clause.name]: clause.value })}::jsonb`;
    }
    case 'body': {
      const sides = clause.side === 'any' ? (['req', 'res'] as const) : ([clause.side] as const);
      const parts = sides.map((side) =>
        clause.mode === 'word'
          ? Prisma.sql`${Prisma.raw(`${side}_tsv`)} @@ phraseto_tsquery('simple', ${clause.value})`
          : Prisma.sql`${Prisma.raw(`${side}_body`)} ILIKE ${`%${escapeLike(clause.value)}%`} ESCAPE '\\'`,
      );
      return parts.length === 1 ? (parts[0]) : Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
    }
    case 'json': {
      const [asText, asValue] = jsonProbes(clause.path, clause.value);
      return asText === asValue
        ? Prisma.sql`res_json @> ${asText}::jsonb`
        : Prisma.sql`(res_json @> ${asText}::jsonb OR res_json @> ${asValue}::jsonb)`;
    }
    case 'regex':
      return Prisma.sql`res_body ~* ${clause.value}`;
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
    where.push(clause.neg ? Prisma.sql`NOT COALESCE((${sql}), false)` : sql);
  }
  if (request.cursor) {
    where.push(Prisma.sql`(ts, id) < (${new Date(request.cursor.ts)}, ${request.cursor.id}::bigint)`);
  }

  return Prisma.sql`
    SELECT ${LIST_COLUMNS}
    FROM public.og_traffic_search
    WHERE ${Prisma.join(where, ' AND ')}
    ORDER BY ts DESC, id DESC
    LIMIT ${request.limit + 1}
  `;
}
