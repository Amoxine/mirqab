import { FULLTEXT_COLUMN } from './traffic-search.sql';

/**
 * The search projection: one redacted row per captured request, range-partitioned by UTC day.
 * Created at API boot (and by the store's cron), never by a Prisma migration: a table that is not in
 * `schema.prisma` is proposed for DROP by `prisma migrate dev`, which is also why the pump's own tables
 * live outside it. Every statement is idempotent. One `DO` block, because a prepared statement cannot
 * hold several commands.
 *
 * Indexes (chosen from a 500k-row benchmark, `docs/ANALYTICS-PIPELINE.md`):
 *  - `(apiid, ts DESC)` and `(apiid, method, ts DESC)`: tenant + window, newest first; cheap.
 *  - GIN `jsonb_path_ops` on both header columns: `header:` clauses; small.
 *  - GIN on the stored `fts` column: word search over the bodies; the costly one (it caps inserts).
 *  Left out on purpose: trigram, JSON-body, path and partial-status indexes (measured expensive or unused).
 *
 * `fts` is a plain column the indexer fills (`to_tsvector` of both bodies, computed once at insert); it is not a
 * generated column because adding one to a table that has rows rewrites every partition. A table built before the
 * column existed gets it by `ADD COLUMN` (a metadata change) and loses the expression index it replaces; its rows have
 * no `fts` until the indexer rebuilds them (`PROJECTION_RULES_VERSION` changed, so it does), and a search meanwhile
 * reports `coverage: partial`, never a wrong answer: a NULL vector matches nothing.
 *
 * `id` comes from a sequence, not an identity column: a partitioned table cannot have one on PG 16.
 * It is unique only together with `ts`, so the dedupe key is `(ts, dedupe_key)`.
 *
 * The state row (`og_traffic_search_state`, one row) is the indexer's memory: `scanned_until` (everything
 * before it was copied), `indexed_from` (the earliest instant the table covers: a search window that starts
 * earlier is only partly answered), `generation` (raised by every reset, so a scan that started before a
 * TRUNCATE cannot write into the table after it), `redaction_tag` (the rules the rows were built under; a
 * different tag rebuilds the table) and `auth_headers` (each API's configured auth header when its rows were
 * built). The table is derived data: every column added later is added with `ADD COLUMN IF NOT EXISTS`
 * above, so an older table is upgraded in place and the tag then rebuilds what the new rules need.
 *
 * Header-exists clauses (`@?` on the `jsonb_path_ops` indexes) cannot narrow by key: the index hashes path+value, so it
 * answers `@>` (name and value) but holds no bare keys, and the planner reads the window's rows and filters. That scales
 * with the rows the tenant and time predicates leave, not with the header; see the query builder.
 */
export const TRAFFIC_SEARCH_DDL = `
DO $$ BEGIN
  CREATE SEQUENCE IF NOT EXISTS public.og_traffic_search_id_seq;

  CREATE TABLE IF NOT EXISTS public.og_traffic_search (
    id            bigint      NOT NULL DEFAULT nextval('public.og_traffic_search_id_seq'),
    ts            timestamptz NOT NULL,
    apiid         text        NOT NULL,
    method        text        NOT NULL DEFAULT '',
    path          text        NOT NULL DEFAULT '',
    status        integer     NOT NULL DEFAULT 0,
    latency_ms    integer     NOT NULL DEFAULT 0,
    key_alias     text        NOT NULL DEFAULT '',
    ip            text        NOT NULL DEFAULT '',
    req_headers   jsonb       NOT NULL DEFAULT '{}'::jsonb,
    res_headers   jsonb       NOT NULL DEFAULT '{}'::jsonb,
    req_body      text        NOT NULL DEFAULT '',
    res_body      text        NOT NULL DEFAULT '',
    req_truncated boolean     NOT NULL DEFAULT false,
    res_truncated boolean     NOT NULL DEFAULT false,
    dedupe_key    text        NOT NULL,
    unredactable  boolean     NOT NULL DEFAULT false,
    fts           tsvector
  ) PARTITION BY RANGE (ts);

  -- A table created before this column existed: a constant default is a metadata change, not a rewrite, and
  -- on a partitioned table the column is added to every partition.
  ALTER TABLE public.og_traffic_search ADD COLUMN IF NOT EXISTS unredactable boolean NOT NULL DEFAULT false;
  ALTER TABLE public.og_traffic_search ADD COLUMN IF NOT EXISTS fts tsvector;

  ALTER SEQUENCE public.og_traffic_search_id_seq OWNED BY public.og_traffic_search.id;

  CREATE UNIQUE INDEX IF NOT EXISTS og_traffic_search_dedupe
    ON public.og_traffic_search (ts, dedupe_key);
  CREATE INDEX IF NOT EXISTS og_traffic_search_apiid_ts
    ON public.og_traffic_search (apiid, ts DESC);
  CREATE INDEX IF NOT EXISTS og_traffic_search_apiid_method_ts
    ON public.og_traffic_search (apiid, method, ts DESC);
  CREATE INDEX IF NOT EXISTS og_traffic_search_req_headers
    ON public.og_traffic_search USING gin (req_headers jsonb_path_ops);
  CREATE INDEX IF NOT EXISTS og_traffic_search_res_headers
    ON public.og_traffic_search USING gin (res_headers jsonb_path_ops);
  CREATE INDEX IF NOT EXISTS og_traffic_search_fts_col
    ON public.og_traffic_search USING gin (${FULLTEXT_COLUMN});
  -- The expression index this one replaces (it cannot serve a query on the column, and costs every insert).
  DROP INDEX IF EXISTS public.og_traffic_search_fts;

  CREATE TABLE IF NOT EXISTS public.og_traffic_search_state (
    id            smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    scanned_until timestamptz NOT NULL,
    indexed_from  timestamptz,
    generation    bigint      NOT NULL DEFAULT 0,
    redaction_tag text,
    auth_headers  jsonb       NOT NULL DEFAULT '{}'::jsonb
  );
  ALTER TABLE public.og_traffic_search_state ADD COLUMN IF NOT EXISTS indexed_from timestamptz;
  ALTER TABLE public.og_traffic_search_state ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;
  ALTER TABLE public.og_traffic_search_state ADD COLUMN IF NOT EXISTS redaction_tag text;
  ALTER TABLE public.og_traffic_search_state ADD COLUMN IF NOT EXISTS auth_headers jsonb NOT NULL DEFAULT '{}'::jsonb;
END $$;
`;

const PARTITION_PREFIX = 'og_traffic_search_';
/** `og_traffic_search_YYYYMMDD`; anything else in the schema is left alone by the retention drop. */
const PARTITION_NAME = /^og_traffic_search_(\d{4})(\d{2})(\d{2})$/;

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** The UTC day a timestamp falls in, as a Date at 00:00:00.000Z. */
export function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export function addDays(day: Date, days: number): Date {
  return new Date(day.getTime() + days * 86_400_000);
}

export function partitionName(day: Date): string {
  const d = utcDay(day);
  return `${PARTITION_PREFIX}${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}`;
}

/** The day a partition holds, or `null` for a table that is not one of ours. */
export function partitionDay(name: string): Date | null {
  const m = PARTITION_NAME.exec(name);
  if (!m) return null;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return partitionName(day) === name ? day : null;
}

const isoDate = (day: Date): string =>
  `${pad(day.getUTCFullYear(), 4)}-${pad(day.getUTCMonth() + 1, 2)}-${pad(day.getUTCDate(), 2)}`;

/**
 * DDL for one day's partition. The name and both bounds are built from numbers of a `Date`, never
 * from text, so nothing user-controlled reaches the statement.
 */
export function partitionDdl(day: Date): string {
  const from = utcDay(day);
  return `CREATE TABLE IF NOT EXISTS public.${partitionName(from)} PARTITION OF public.og_traffic_search FOR VALUES FROM ('${isoDate(from)} 00:00:00+00') TO ('${isoDate(addDays(from, 1))} 00:00:00+00')`;
}

/** Partitions whose whole day is older than `retentionDays` before `now`. */
export function expiredPartitions(names: string[], retentionDays: number, now: Date): string[] {
  const cutoff = addDays(utcDay(now), -retentionDays);
  return names.filter((name) => {
    const day = partitionDay(name);
    return day !== null && day.getTime() < cutoff.getTime();
  });
}

/** Drop statement for a partition name that `partitionDay` accepted; refuses anything else. */
export function dropPartitionDdl(name: string): string {
  if (partitionDay(name) === null) throw new Error(`Not a traffic-search partition: ${name}`);
  return `DROP TABLE IF EXISTS public.${name}`;
}
