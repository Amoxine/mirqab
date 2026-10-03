import '../../../common/testing/throwaway-db.guard'; // must stay first: refuses to load against the stack database
import { Logger } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import { TRAFFIC_SEARCH_DDL, partitionDdl } from '../search/traffic-search.ddl';
import { redactFieldsFrom } from './pump-query.builder';
import { readState, TAG_PENDING } from '../search/traffic-search.state';
import { BACKFILL_BATCH_ROWS, ensureRedaction, redactionTag } from './redaction-installer';

/**
 * Redaction upgrades against a REAL Postgres: a first install records the rules' version, a changed
 * version re-redacts the retained rows in small windows, clears the search projection, and only then
 * records the new version, so a failure is retried. Not part of `jest` (the name does not match
 * `.spec.ts`): it needs a THROWAWAY database — never the stack's.
 *
 *   docker run -d --rm --name og-probe-search-pg -e POSTGRES_USER=t -e POSTGRES_PASSWORD=t \
 *     -e POSTGRES_DB=t -p 127.0.0.1:55451:5432 postgres:16-alpine
 *   export OG_THROWAWAY_DATABASE_URL='postgresql://t:t@127.0.0.1:55451/t?schema=public'
 *   (cd apps/api && DATABASE_URL=$OG_THROWAWAY_DATABASE_URL npx jest --runInBand --testRegex 'redaction-installer\.db-spec\.ts$')
 *   docker rm -f og-probe-search-pg
 */

jest.setTimeout(120_000);

const NOW = new Date('2026-09-29T12:00:00.000Z');
const FIELDS = redactFieldsFrom(undefined);
const TAG = redactionTag(FIELDS);
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const b64 = (t: string): string => Buffer.from(t, 'utf8').toString('base64');
const leaky = b64(`POST /x HTTP/1.1\r\n\r\n{"password":"PLANTED-PW","payload":"${JWT}","keep":"visible"}`);

describe('redaction installer on a real Postgres', () => {
  const tag = async (): Promise<string | null> =>
    (await prisma.$queryRaw<{ t: string | null }[]>`SELECT obj_description(to_regprocedure('public.og_redact_http_dump(text,text)'), 'pg_proc') AS t`)[0]?.t ?? null;
  const functionPresent = async (): Promise<boolean> =>
    (await prisma.$queryRaw<{ p: boolean }[]>`SELECT to_regprocedure('public.og_redact_http_dump(text,text)') IS NOT NULL AS p`)[0]?.p ?? false;
  const stored = async (): Promise<string> =>
    (await prisma.$queryRaw<{ r: string }[]>`SELECT coalesce(string_agg(convert_from(decode(rawrequest, 'base64'), 'UTF8'), E'\n'), '') AS r FROM public.tyk_analytics WHERE rawrequest <> ''`)[0]?.r ?? '';
  const insertRaw = async (daysAgo: number, key: string) => {
    await prisma.$executeRawUnsafe(`ALTER TABLE public.tyk_analytics DISABLE TRIGGER USER`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.tyk_analytics ("timestamp", apiid, apikey, rawrequest, rawresponse) VALUES ($1::timestamptz, 'a1', $2, $3, '')`,
      new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
      key,
      leaky,
    );
    await prisma.$executeRawUnsafe(`ALTER TABLE public.tyk_analytics ENABLE ALWAYS TRIGGER og_redact_tyk_analytics_trg`);
  };
  const reset = async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS public.tyk_analytics, public.og_traffic_search, public.og_traffic_search_state CASCADE');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS public.og_redact_http_dump(text, text) CASCADE');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS public.og_redact_tyk_analytics() CASCADE');
    await prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS public.og_traffic_search_id_seq');
  };
  const makeTable = () =>
    prisma.$executeRawUnsafe(
      `CREATE TABLE public.tyk_analytics ("timestamp" timestamptz, apiid text, apikey text, rawrequest text, rawresponse text)`,
    );

  beforeAll(() => {
    Logger.overrideLogger(false);
    const url = process.env.DATABASE_URL;
    if (!url || url !== process.env.OG_THROWAWAY_DATABASE_URL || url.includes(':33002')) {
      throw new Error('Refusing to run: DATABASE_URL must equal OG_THROWAWAY_DATABASE_URL and must not be the stack database');
    }
  });
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await prisma.$disconnect();
  });

  it('with no pump table yet it installs nothing and does not fail', async () => {
    const install = await ensureRedaction(prisma, FIELDS, 30, NOW);
    expect(install.upgrading).toBe(false);
    expect(await functionPresent()).toBe(false);
    expect(await install.done).toEqual({ windows: 0, rows: 0 });
  });

  it('a first install records the version and rewrites nothing', async () => {
    await makeTable();
    const install = await ensureRedaction(prisma, FIELDS, 30, NOW);
    expect(install.upgrading).toBe(false);
    expect(await tag()).toBe(TAG);
    expect(await install.done).toEqual({ windows: 0, rows: 0 });
  });

  it('a second run with the same rules is a no-op', async () => {
    await makeTable();
    await ensureRedaction(prisma, FIELDS, 30, NOW);
    await insertRaw(1, 'k1'); // the trigger redacts on insert: this row is already clean
    const again = await ensureRedaction(prisma, FIELDS, 30, NOW);
    expect(again.upgrading).toBe(false);
    expect(await again.done).toEqual({ windows: 0, rows: 0 });
  });

  it('changed rules: stored rows are re-redacted, the projection is cleared, and only then is the version recorded', async () => {
    await makeTable();
    await ensureRedaction(prisma, FIELDS, 30, NOW);
    // Pretend the installed rules are older and let weaker redaction through: rows stored while an old function ran.
    await prisma.$executeRawUnsafe(`COMMENT ON FUNCTION public.og_redact_http_dump(text, text) IS 'ddl:old'`);
    await prisma.$executeRawUnsafe(`ALTER TABLE public.tyk_analytics DISABLE TRIGGER USER`);
    for (const [days, key] of [[1, 'k1'], [2, 'k2'], [3, 'k3']] as const) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO public.tyk_analytics ("timestamp", apiid, apikey, rawrequest, rawresponse) VALUES ($1::timestamptz, 'a1', $2, $3, '')`,
        new Date(NOW.getTime() - days * 86_400_000).toISOString(),
        key,
        leaky,
      );
    }
    await prisma.$executeRawUnsafe(`ALTER TABLE public.tyk_analytics ENABLE ALWAYS TRIGGER og_redact_tyk_analytics_trg`);
    expect(await stored()).toContain('PLANTED-PW'); // the fixture really is leaky

    await prisma.$executeRawUnsafe(TRAFFIC_SEARCH_DDL);
    await prisma.$executeRawUnsafe(partitionDdl(new Date('2026-09-28T00:00:00Z')));
    await prisma.$executeRawUnsafe(`INSERT INTO public.og_traffic_search (ts, apiid, dedupe_key, res_body) VALUES ('2026-09-28T10:00:00Z', 'a1', 'x', 'derived from old rules')`);
    await prisma.$executeRawUnsafe(`INSERT INTO public.og_traffic_search_state (id, scanned_until) VALUES (1, now())`);

    const install = await ensureRedaction(prisma, FIELDS, 30, NOW);
    expect(install.upgrading).toBe(true);
    const result = await install.done;

    expect(result.rows).toBe(3);
    expect(result.windows).toBeGreaterThan(3); // many short windows, not one statement
    const after = await stored();
    expect(after).not.toContain('PLANTED-PW');
    expect(after).not.toContain('eyJ');
    expect(after).toContain('visible');
    expect(await tag()).toBe(TAG);
    expect(Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM public.og_traffic_search`)[0]?.n)).toBe(0);
    // The state is kept, not deleted: a reset raises the generation (a scan that began before it can no longer write),
    // clears what is covered, and starts the rebuild at the retention floor, so the WHOLE window is rebuilt and not the
    // first-run backfill. The installer's own reset is marked, so the indexer adopts it instead of resetting again.
    const state = await readState(prisma);
    expect(state?.generation).toBe(1);
    expect(state?.indexedFrom).toBeNull();
    expect(state?.redactionTag).toBe(TAG_PENDING);
    const floorAge = Date.now() - (state?.scannedUntil.getTime() ?? 0);
    expect(floorAge).toBeGreaterThan(30 * 86_400_000 - 60_000);
    expect(floorAge).toBeLessThan(30 * 86_400_000 + 60_000);
  });

  it('rewrites only the rows the function changes: a row that was already clean keeps its version, and a long window is many short statements', async () => {
    await makeTable();
    await ensureRedaction(prisma, FIELDS, 30, NOW);
    // Through the live trigger (unlike `insertRaw`, which bypasses it): already redacted on the way in.
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.tyk_analytics ("timestamp", apiid, apikey, rawrequest, rawresponse) VALUES ($1::timestamptz, 'a1', 'clean-already', $2, '')`,
      new Date(NOW.getTime() - 86_400_000).toISOString(),
      leaky,
    );
    await prisma.$executeRawUnsafe(`COMMENT ON FUNCTION public.og_redact_http_dump(text, text) IS 'ddl:old'`);
    await prisma.$executeRawUnsafe(`ALTER TABLE public.tyk_analytics DISABLE TRIGGER USER`);
    // BACKFILL_BATCH_ROWS * 2 + 25 leaky rows inside one 10-minute window: more than two batches' worth.
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.tyk_analytics ("timestamp", apiid, apikey, rawrequest, rawresponse)
       SELECT $1::timestamptz + (g || ' seconds')::interval, 'a1', 'leaky' || g, $2, '' FROM generate_series(1, ${String(BACKFILL_BATCH_ROWS * 2 + 25)}) g`,
      new Date(NOW.getTime() - 3 * 86_400_000).toISOString(),
      leaky,
    );
    await prisma.$executeRawUnsafe(`ALTER TABLE public.tyk_analytics ENABLE ALWAYS TRIGGER og_redact_tyk_analytics_trg`);
    const versionOf = async (key: string): Promise<string> => (await prisma.$queryRaw<{ x: string }[]>`SELECT xmin::text AS x FROM public.tyk_analytics WHERE apikey = ${key}`)[0]?.x ?? '';
    const cleanBefore = await versionOf('clean-already');

    const install = await ensureRedaction(prisma, FIELDS, 30, NOW);
    const result = await install.done;

    expect(result.rows).toBe(BACKFILL_BATCH_ROWS * 2 + 25); // only the leaky ones were rewritten
    expect(await versionOf('clean-already')).toBe(cleanBefore); // not touched: an UPDATE that writes the same value still makes a new row version
    expect(await stored()).not.toContain('PLANTED-PW');
  });

  it('a second pass over what the backfill wrote changes nothing', async () => {
    await makeTable();
    await ensureRedaction(prisma, FIELDS, 30, NOW);
    await prisma.$executeRawUnsafe(`COMMENT ON FUNCTION public.og_redact_http_dump(text, text) IS 'ddl:old'`);
    await insertRaw(1, 'k1');
    await (await ensureRedaction(prisma, FIELDS, 30, NOW)).done;
    await prisma.$executeRawUnsafe(`COMMENT ON FUNCTION public.og_redact_http_dump(text, text) IS 'ddl:old'`);
    const again = await (await ensureRedaction(prisma, FIELDS, 30, NOW)).done;
    expect(again.rows).toBe(0);
  });

  it('an install from before versions existed (no tag) counts as changed', async () => {
    await makeTable();
    await ensureRedaction(prisma, FIELDS, 30, NOW);
    await prisma.$executeRawUnsafe(`COMMENT ON FUNCTION public.og_redact_http_dump(text, text) IS NULL`);
    const install = await ensureRedaction(prisma, FIELDS, 30, NOW);
    expect(install.upgrading).toBe(true);
    await install.done;
    expect(await tag()).toBe(TAG);
  });

  it('a failed backfill keeps the old version, so the next run tries again and finishes', async () => {
    await makeTable();
    await ensureRedaction(prisma, FIELDS, 30, NOW);
    await prisma.$executeRawUnsafe(`COMMENT ON FUNCTION public.og_redact_http_dump(text, text) IS 'ddl:old'`);
    await insertRaw(1, 'k1');

    const failing = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === '$executeRaw') return () => Promise.reject(new Error('disk full'));
        const v: unknown = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const first = await ensureRedaction(failing, FIELDS, 30, NOW);
    expect(first.upgrading).toBe(true);
    expect(await first.done).toEqual({ windows: 0, rows: 0 });
    expect(await tag()).toBe('ddl:old'); // not recorded: the rows may still be unfixed

    const second = await ensureRedaction(prisma, FIELDS, 30, NOW);
    await second.done;
    expect(await tag()).toBe(TAG);
  });

  it('rewrites only what is inside the retention window (older rows are about to be deleted anyway)', async () => {
    await makeTable();
    await ensureRedaction(prisma, FIELDS, 30, NOW);
    await prisma.$executeRawUnsafe(`COMMENT ON FUNCTION public.og_redact_http_dump(text, text) IS 'ddl:old'`);
    await prisma.$executeRawUnsafe(`ALTER TABLE public.tyk_analytics DISABLE TRIGGER USER`);
    for (const [days, key] of [[1, 'recent'], [20, 'old']] as const) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO public.tyk_analytics ("timestamp", apiid, apikey, rawrequest, rawresponse) VALUES ($1::timestamptz, 'a1', $2, $3, '')`,
        new Date(NOW.getTime() - days * 86_400_000).toISOString(),
        key,
        leaky,
      );
    }
    await prisma.$executeRawUnsafe(`ALTER TABLE public.tyk_analytics ENABLE ALWAYS TRIGGER og_redact_tyk_analytics_trg`);

    const install = await ensureRedaction(prisma, FIELDS, 5, NOW); // a 5-day window
    expect((await install.done).rows).toBe(1);
    const rows = await prisma.$queryRaw<{ apikey: string; leaked: boolean }[]>`
      SELECT apikey, convert_from(decode(rawrequest, 'base64'), 'UTF8') LIKE '%PLANTED-PW%' AS leaked FROM public.tyk_analytics ORDER BY apikey`;
    expect(rows).toEqual([{ apikey: 'old', leaked: true }, { apikey: 'recent', leaked: false }]);
  });
});
