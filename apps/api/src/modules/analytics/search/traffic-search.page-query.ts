import { Prisma } from '@prisma/client';

/** Rows one page of the indexer reads. */
export const BATCH_SIZE = 500;

/** Where the last page stopped: the cursor is the row comparison `(timestamp, dedupe_key)`. */
export interface PageCursor {
  /** ISO text with microseconds: a `Date` would round it. */
  ts: string;
  key: string;
}

/**
 * One keyset page of captured rows (`tyk_analytics`) the search projection does not hold yet, in `(timestamp, dedupe_key)`
 * order. The SQL is here, not in the indexer, so a database spec can EXPLAIN exactly what runs.
 *
 * The key is the sha256 of a JSON ARRAY of the identifying columns, not of a `|`-joined string: with a separator,
 * `a|b` + `c` and `a` + `b|c` were the same key.
 *
 * Three bounds keep a page cheap however far the backlog has been worked through:
 *  1. the pump rows start at the cursor's timestamp. The row comparison on the computed key alone is not an index
 *     condition (Postgres derives the timestamp bound from it today, but only as a side effect of the plan);
 *  2. the projection side of the anti-join starts at the CURSOR too, not at the start of the window. A captured row at or
 *     after the cursor can only match a projection row at or after it, and without this the planner merge-joined against
 *     everything indexed so far: measured 41 ms, 240 ms, 539 ms, 589 ms, 811 ms for the page after 1, 75k, 150k, 225k and
 *     299k indexed rows, against a flat 50-60 ms. Bounding it by the WINDOW (the obvious fix) measured no better;
 *  3. both sides end at the scan's `to`;
 *  4. `OFFSET 0` ends the inner query as an optimisation fence, so the dedupe key is computed ONCE per captured row. Without it
 *     the planner inlines the sha256 expression into the join condition, and a plan that compares every captured row with
 *     every projection row of the same timestamp (a nested loop, which is what it picks for a pump table that has not been
 *     analyzed yet) evaluates it per PAIR: 885,000 times, 29 s, for 1,330 rows that share one timestamp.
 *
 * A partial index on the captured rows' timestamp (`og_tyk_analytics_captured_ts`, in `ANALYTICS_INDEX_DDL`) serves the pump
 * side: without it each page also read and discarded the uncaptured rows in between (2,506 per 500 here, a thousand
 * times that where recording is on for one API in a hundred).
 */
export function capturedPageSql(from: Date, to: Date, after: PageCursor | null): Prisma.Sql {
  const lower = after ? Prisma.sql`AND "timestamp" >= ${after.ts}::timestamptz` : Prisma.empty;
  const cursor = after ? Prisma.sql`AND ("timestamp", dedupe_key) > (${after.ts}::timestamptz, ${after.key})` : Prisma.empty;
  const projectionFrom = after ? Prisma.sql`${after.ts}::timestamptz` : Prisma.sql`${from}`;
  return Prisma.sql`
    SELECT * FROM (
      SELECT to_char("timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts_iso,
             "timestamp", apiid, apikey, alias, ipaddress, method, path, responsecode, latency_total,
             rawrequest, rawresponse,
             encode(sha256(convert_to(jsonb_build_array(apiid,
               to_char("timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
               apikey, method, path, responsecode, latency_total, requesttime)::text, 'UTF8')), 'hex') AS dedupe_key
        FROM public.tyk_analytics
       WHERE (rawrequest <> '' OR rawresponse <> '')
         AND "timestamp" >= ${from} AND "timestamp" < ${to}
         ${lower}
       OFFSET 0
    ) captured
    WHERE NOT EXISTS (
            SELECT 1 FROM public.og_traffic_search s
             WHERE s.ts >= ${projectionFrom} AND s.ts < ${to}
               AND s.ts = captured."timestamp" AND s.dedupe_key = captured.dedupe_key)
      ${cursor}
    ORDER BY "timestamp", dedupe_key
    LIMIT ${BATCH_SIZE}
  `;
}
