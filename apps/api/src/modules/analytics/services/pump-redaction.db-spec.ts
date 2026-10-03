import '../../../common/testing/throwaway-db.guard'; // must stay first: refuses to load against the stack database
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Prisma, prisma } from '@open-gateway/database';
import type { RedisService } from '../../../common/redis/redis.service';
import { AnalyticsRetentionScheduler } from './analytics-retention.scheduler';
import { AnalyticsService } from './analytics.service';
import type { PumpHealthService } from './pump-health.service';
import { analyticsRedactionDdl, MAX_REDACTED_DUMP_CHARS, TRUNCATED_DUMP_MARKER, UNREDACTABLE_DUMP_PLACEHOLDER } from './pump-query.builder';

/**
 * The `tyk_analytics` redaction trigger and index DDL against a REAL Postgres (AC-LOG02.6, AC-LOG02.7):
 * a non-UTF-8 or non-base64 dump in one column is replaced by a base64 placeholder in THAT column only,
 * the other column is untouched, and a multi-row INSERT (the pump's batch) never aborts. The mocked
 * `analytics.service.spec.ts` only string-matches the DDL; this proves the exception path. Installed
 * through the real `AnalyticsService.onModuleInit`, and first through the real retention scheduler on
 * a cold stack (table created after boot: the dumps stored before the trigger existed get redacted).
 * Not part of `jest` (the name does not match
 * `.spec.ts`): it needs a THROWAWAY database — never the stack's. No migrations needed: the pump owns
 * `tyk_analytics`, so the test creates the columns the trigger and indexes touch.
 *
 *   docker run -d --rm --name og-probe-redact-pg -e POSTGRES_USER=t -e POSTGRES_PASSWORD=t \
 *     -e POSTGRES_DB=t -p 127.0.0.1:55449:5432 postgres:16-alpine
 *   export OG_THROWAWAY_DATABASE_URL='postgresql://t:t@127.0.0.1:55449/t?schema=public'
 *   (cd apps/api && DATABASE_URL=$OG_THROWAWAY_DATABASE_URL npx jest --runInBand --testRegex 'pump-redaction\.db-spec\.ts$')
 *   docker rm -f og-probe-redact-pg
 */

jest.setTimeout(60_000);

const b64 = (data: string | Buffer): string => Buffer.from(data).toString('base64');
const PLACEHOLDER_B64 = b64(UNREDACTABLE_DUMP_PLACEHOLDER);

/** A gzip response body: magic bytes plus invalid UTF-8 — `convert_from(..., 'UTF8')` throws on it. */
const NON_UTF8_DUMP = Buffer.concat([
  Buffer.from('HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nAuthorization: Bearer leaked-token\r\n\r\n'),
  Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0xc3, 0x28]),
]);
const CLEAN_DUMP = 'GET /orders HTTP/1.1\r\nHost: api.example.com\r\nAccept: application/json\r\n\r\n';
const SECRET_DUMP =
  'POST /login HTTP/1.1\r\nAuthorization: Bearer real-token\r\nContent-Type: application/json\r\n\r\n{"user":"bob","password":"hunter2"}';

interface Row {
  rawrequest: string | null;
  rawresponse: string | null;
}

describe('tyk_analytics redaction trigger on a real Postgres', () => {
  const apiIds: string[] = [];
  const config = { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService;
  const service = new AnalyticsService(prisma, {} as RedisService, {} as PumpHealthService, config);
  const scheduler = new AnalyticsRetentionScheduler(prisma, config);
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    const url = process.env.DATABASE_URL;
    if (!url || url !== process.env.OG_THROWAWAY_DATABASE_URL || url.includes(':33002')) {
      throw new Error('Refusing to run: DATABASE_URL must equal OG_THROWAWAY_DATABASE_URL and must not be the stack database');
    }
    // Cold stack: the API boots before the pump has created its table (throwaway DB only, guarded above).
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS public.tyk_analytics');
    warn = jest.spyOn(Logger.prototype, 'warn');
    error = jest.spyOn(Logger.prototype, 'error');
    await service.onModuleInit();
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM public.tyk_analytics WHERE apiid = ANY(${apiIds}::text[])`;
    await prisma.$disconnect();
  });

  /** One multi-row INSERT, like the pump's batch; returns the stored rows in insertion order. */
  async function insert(rows: { req: string | null; res: string | null }[]): Promise<Row[]> {
    const ids = rows.map(() => randomUUID());
    apiIds.push(...ids);
    const values = rows.map((r, i) => Prisma.sql`(${ids[i]}, 'k', ${r.req}, ${r.res})`);
    await prisma.$executeRaw`INSERT INTO public.tyk_analytics (apiid, apikey, rawrequest, rawresponse) VALUES ${Prisma.join(values)}`;
    const stored = await prisma.$queryRaw<(Row & { apiid: string })[]>`
      SELECT apiid, rawrequest, rawresponse FROM public.tyk_analytics WHERE apiid = ANY(${ids}::text[])`;
    return ids.map((id) => {
      const { rawrequest, rawresponse } = stored.find((s) => s.apiid === id) as Row;
      return { rawrequest, rawresponse };
    });
  }

  /**
   * Strict base64 (Buffer.from silently skips junk, so the alphabet is checked first). Newlines are
   * allowed: Postgres `encode(..., 'base64')` wraps every 76 characters, so a re-encoded dump longer
   * than 57 bytes is the same bytes but not the same string — compare decoded content.
   */
  const decodeStrict = (value: string | null): string => {
    expect(value).toMatch(/^[A-Za-z0-9+/\n]*={0,2}$/);
    return Buffer.from(value ?? '', 'base64').toString('utf8');
  };

  const triggerCount = async (): Promise<number> => {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM pg_trigger WHERE tgname = 'og_redact_tyk_analytics_trg' AND NOT tgisinternal`;
    return Number(rows[0].n);
  };

  it('cold stack: the pump creates the table after boot; the retention scheduler installs the trigger and redacts the dumps stored meanwhile', async () => {
    expect(await triggerCount()).toBe(0); // boot found no table, so nothing was installed
    await prisma.$executeRawUnsafe(`
      CREATE TABLE public.tyk_analytics (
        apiid text, apikey text, "timestamp" timestamptz DEFAULT now(), rawrequest text, rawresponse text
      )`);
    const [gap] = await insert([{ req: b64(SECRET_DUMP), res: '' }]);
    expect(decodeStrict(gap.rawrequest)).toContain('real-token'); // the race: stored unredacted
    const gapId = apiIds[apiIds.length - 1];

    await scheduler.purgeExpiredAnalytics();
    await scheduler.purgeExpiredAnalytics(); // idempotent

    expect(error).not.toHaveBeenCalled();
    expect(await triggerCount()).toBe(1);
    const [healed] = await prisma.$queryRaw<Row[]>`
      SELECT rawrequest, rawresponse FROM public.tyk_analytics WHERE apiid = ${gapId}`;
    const request = decodeStrict(healed.rawrequest);
    expect(request).not.toContain('real-token');
    expect(request).not.toContain('hunter2');
    expect(request).toContain('Authorization: [REDACTED]');
    expect(request).toContain('"user":"bob"');
    expect(healed.rawresponse).toBe('');
    const [after] = await insert([{ req: b64(SECRET_DUMP), res: '' }]);
    expect(decodeStrict(after.rawrequest)).not.toContain('real-token'); // the trigger is live
    const indexes = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM pg_indexes WHERE tablename = 'tyk_analytics' AND indexname LIKE 'og_tyk_analytics_%'`;
    expect(Number(indexes[0].n)).toBe(5); // the three leading-column ones, the captured-rows one, and the captured-rows timestamp one the search indexer reads
  });

  it('installs both DDL statements through onModuleInit without a warning', async () => {
    await service.onModuleInit();
    await service.onModuleInit(); // idempotent: a second boot re-applies cleanly
    expect(warn).not.toHaveBeenCalled();
    const triggers = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM pg_trigger WHERE tgname = 'og_redact_tyk_analytics_trg' AND NOT tgisinternal`;
    expect(Number(triggers[0].n)).toBe(1);
  });

  it('non-UTF-8 rawrequest, valid rawresponse: the insert succeeds, only rawrequest becomes the placeholder', async () => {
    const [row] = await insert([{ req: b64(NON_UTF8_DUMP), res: b64(CLEAN_DUMP) }]);

    expect(row.rawrequest).toBe(PLACEHOLDER_B64);
    expect(decodeStrict(row.rawrequest)).toBe(UNREDACTABLE_DUMP_PLACEHOLDER);
    expect(decodeStrict(row.rawresponse)).toBe(CLEAN_DUMP); // untouched
  });

  it('valid rawrequest, non-UTF-8 rawresponse: the good column is still redacted, the bad one is the placeholder', async () => {
    const [row] = await insert([{ req: b64(SECRET_DUMP), res: b64(NON_UTF8_DUMP) }]);

    const request = decodeStrict(row.rawrequest);
    expect(request).toContain('Authorization: [REDACTED]');
    expect(request).toContain('"password":"[REDACTED]"');
    expect(request).toContain('"user":"bob"');
    expect(request).not.toContain('real-token');
    expect(row.rawresponse).toBe(PLACEHOLDER_B64);
  });

  it('never stores the unredacted original on the exception path, and Postgres itself can decode the placeholder', async () => {
    const [row] = await insert([{ req: b64(NON_UTF8_DUMP), res: '!!not base64!!' }]);

    expect(row.rawrequest).not.toBe(b64(NON_UTF8_DUMP));
    expect(decodeStrict(row.rawrequest)).not.toContain('leaked-token');
    expect(row.rawresponse).toBe(PLACEHOLDER_B64); // bad base64 fails closed the same way
    const decoded = await prisma.$queryRaw<{ req: string; res: string }[]>`
      SELECT convert_from(decode(rawrequest, 'base64'), 'UTF8') AS req, convert_from(decode(rawresponse, 'base64'), 'UTF8') AS res
      FROM public.tyk_analytics WHERE apiid = ${apiIds[apiIds.length - 1]}`;
    expect(decoded[0]).toEqual({ req: UNREDACTABLE_DUMP_PLACEHOLDER, res: UNREDACTABLE_DUMP_PLACEHOLDER });
  });

  it('JSON body fields: an escaped quote cannot leak the tail of a value, and numeric values are redacted too', async () => {
    const body = String.raw`{"token":"ab\"TAIL","cvv":123,"ssn":-1.5e3,"name":"x\"y","password":"end\\"}`;
    const [row] = await insert([{ req: b64(`POST /pay HTTP/1.1\r\nContent-Type: application/json\r\n\r\n${body}`), res: '' }]);

    const stored = decodeStrict(row.rawrequest).split('\r\n\r\n')[1];
    expect(stored).not.toContain('TAIL');
    expect(JSON.parse(stored)).toEqual({
      token: '[REDACTED]',
      cvv: '[REDACTED]',
      ssn: '[REDACTED]',
      name: 'x"y', // not a configured field: untouched, escaped quote and all
      password: '[REDACTED]',
    });
  });

  it('a configured field holding an object or array is redacted whole; a } inside a string does not end it', async () => {
    const body =
      '{"id":1,"credential":{"a":"x}y","b":"SECRET-B"},"token":["T1","T2"],"password":{"n":{"m":"DEEP-C"}},"tail":"after"}';
    const [row] = await insert([{ req: b64(`POST /x HTTP/1.1\r\n\r\n${body}`), res: '' }]);

    const stored = decodeStrict(row.rawrequest).split('\r\n\r\n')[1];
    expect(stored).not.toMatch(/SECRET-B|T1|T2|DEEP-C|x}y/);
    // Flat containers are replaced in place; the deeper one blanks to the end of the dump (safe, not precise).
    expect(stored).toBe('{"id":1,"credential":"[REDACTED]","token":"[REDACTED]","password":"[REDACTED]"');
  });

  it('flat containers keep the fields after them readable', async () => {
    const [row] = await insert([
      { req: b64('POST /x HTTP/1.1\r\n\r\n{"secret":{"k":"v"},"keep":"me","token":[1,2],"n":3}'), res: '' },
    ]);
    expect(decodeStrict(row.rawrequest).split('\r\n\r\n')[1]).toBe(
      '{"secret":"[REDACTED]","keep":"me","token":"[REDACTED]","n":3}',
    );
  });

  it('a dense body of secret-named objects also stays fast', async () => {
    const dense = `POST / HTTP/1.1\r\n\r\n{${'"token":{"a":"}"},'.repeat(1_000)}"n":1}`;
    const started = Date.now();
    const [row] = await insert([{ req: b64(dense), res: '' }]);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(decodeStrict(row.rawrequest)).not.toContain('"a"');
  });

  it('a JWT is hidden by its shape, in a field, header, query string or path with an innocent name', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const long = `eyJhbGciOiJIUzI1NiJ9.${'eyJzdWIiOiIx'.repeat(120)}.c2lnbmF0dXJl`; // a payload well past 255 characters
    const [row] = await insert([
      {
        req: b64(`GET /cb/${jwt}?data=${jwt} HTTP/1.1\r\nX-Trace: ${jwt}\r\n\r\n{"payload":"${jwt}","long":"${long}","keep":"visible"}`),
        res: b64(`HTTP/1.1 200 OK\r\n\r\nnote=${jwt}&keep=visible`),
      },
    ]);
    for (const dump of [decodeStrict(row.rawrequest), decodeStrict(row.rawresponse)]) {
      expect(dump).not.toContain('eyJ');
      expect(dump).toContain('visible');
    }
  });

  it('a body of repeated eyJ cannot make the trigger slow (16 KiB is the most it ever sees)', async () => {
    const started = Date.now();
    const [row] = await insert([{ req: b64(`POST / HTTP/1.1\r\n\r\n${'eyJ'.repeat(6_000)}`), res: b64(`HTTP/1.1 200 OK\r\n\r\n${'eyJabcd.'.repeat(2_500)}`) }]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(decodeStrict(row.rawrequest).length).toBeGreaterThan(0);
  });

  it('default fields cover an OAuth token response: exact keys, so token_type is not redacted', async () => {
    const body = '{"access_token":"at-1","refresh_token":"rt-2","client_secret":"cs-3","token_type":"Bearer"}';
    const [row] = await insert([{ req: '', res: b64(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${body}`) }]);

    const stored = decodeStrict(row.rawresponse).split('\r\n\r\n')[1];
    expect(JSON.parse(stored)).toEqual({
      access_token: '[REDACTED]',
      refresh_token: '[REDACTED]',
      client_secret: '[REDACTED]',
      token_type: 'Bearer',
    });
  });

  /** A JSON dump whose first `MAX_REDACTED_DUMP_CHARS` characters end right after `"token":"TOKENPREFIX<tail>`. */
  const dumpCutInsideToken = (tail: string): string => {
    const head = 'POST /pay HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"password":"p1-secret",';
    const before = `${head}"f":"",'"token":"TOKENPREFIX${tail}`.length;
    const filler = `"f":"${'a'.repeat(MAX_REDACTED_DUMP_CHARS - before)}",`;
    return `${head}${filler}"token":"TOKENPREFIX${tail}${'REST'.repeat(300)}"}`;
  };

  it.each([
    ['inside a string value', 'zzz'],
    ['right after a backslash in the value', 'zz\\'],
  ])('a dump over the cap is cut before redaction, marked, and a secret cut %s does not leak', async (_case, tail) => {
    const original = dumpCutInsideToken(tail);
    const [row] = await insert([{ req: b64(original), res: '' }]);

    const stored = decodeStrict(row.rawrequest);
    expect(stored).not.toContain('p1-secret');
    expect(stored).not.toContain('TOKENPREFIX');
    // What is STORED is exactly the first MAX_REDACTED_DUMP_CHARS characters, redacted, plus the
    // marker: nothing past the cap is kept anywhere in the column, redacted or not.
    const firstChars = original.slice(0, MAX_REDACTED_DUMP_CHARS);
    const expected = firstChars
      .replace('"password":"p1-secret"', '"password":"[REDACTED]"')
      .replace(/"token":"TOKENPREFIX.*$/, '"token":"[REDACTED]"');
    expect(stored).toBe(`${expected}\n${TRUNCATED_DUMP_MARKER}`);
  });

  it('a large body is stored capped: the column is shorter than what the pump inserted, not just redacted', async () => {
    const original = `POST /upload HTTP/1.1\r\nContent-Type: text/plain\r\n\r\n${'lorem ipsum '.repeat(90_000)}`; // ~1 MB
    const [row] = await insert([{ req: b64(original), res: '' }]);

    const stored = decodeStrict(row.rawrequest);
    expect(stored).toBe(`${original.slice(0, MAX_REDACTED_DUMP_CHARS)}\n${TRUNCATED_DUMP_MARKER}`);
    expect((row.rawrequest ?? '').length).toBeLessThan(b64(original).length / 40);
  });

  it('a dump within the cap is stored whole: no marker', async () => {
    const [row] = await insert([{ req: b64(SECRET_DUMP), res: '' }]);

    expect(decodeStrict(row.rawrequest)).not.toContain(TRUNCATED_DUMP_MARKER);
  });

  it('a dense adversarial body cannot hold a single-row INSERT for seconds (was ~11 s at 200 KB)', async () => {
    const dense = `POST / HTTP/1.1\r\n\r\n{${'"cvv":1,'.repeat(25_600)}"n":1}`; // ~200 KB, 25,600 matches

    const started = Date.now();
    const [row] = await insert([{ req: b64(dense), res: '' }]);
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(2_000); // measured ~50 ms; generous for a loaded machine
    expect(decodeStrict(row.rawrequest)).not.toMatch(/"cvv":1/);
  });

  it('a DISABLED trigger counts as missing: re-install re-enables it and redacts what got in meanwhile', async () => {
    await prisma.$executeRawUnsafe('ALTER TABLE public.tyk_analytics DISABLE TRIGGER og_redact_tyk_analytics_trg');
    const [leaked] = await insert([{ req: b64(SECRET_DUMP), res: '' }]);
    expect(decodeStrict(leaked.rawrequest)).toContain('real-token'); // disabled: stored unredacted
    const leakedId = apiIds[apiIds.length - 1];

    await scheduler.purgeExpiredAnalytics();

    const enabled = await prisma.$queryRaw<{ tgenabled: string }[]>`
      SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'og_redact_tyk_analytics_trg' AND NOT tgisinternal`;
    expect(enabled).toEqual([{ tgenabled: 'O' }]);
    const [healed] = await prisma.$queryRaw<Row[]>`
      SELECT rawrequest, rawresponse FROM public.tyk_analytics WHERE apiid = ${leakedId}`;
    expect(decodeStrict(healed.rawrequest)).not.toContain('real-token');
    expect(decodeStrict(healed.rawrequest)).not.toContain('hunter2');
  });

  it('one bad row does not abort the batch: every other row lands, redacted as before', async () => {
    const rows = await insert([
      { req: b64(CLEAN_DUMP), res: b64(CLEAN_DUMP) },
      { req: b64(NON_UTF8_DUMP), res: b64(NON_UTF8_DUMP) },
      { req: b64(SECRET_DUMP), res: '' },
      { req: null, res: null },
    ]);

    expect(rows).toHaveLength(4);
    expect(decodeStrict(rows[0].rawrequest)).toBe(CLEAN_DUMP);
    expect(decodeStrict(rows[0].rawresponse)).toBe(CLEAN_DUMP);
    expect(rows[1]).toEqual({ rawrequest: PLACEHOLDER_B64, rawresponse: PLACEHOLDER_B64 });
    expect(decodeStrict(rows[2].rawrequest)).not.toContain('hunter2');
    expect(rows[2].rawresponse).toBe(''); // recording off: empty stays empty
    expect(rows[3]).toEqual({ rawrequest: null, rawresponse: null });
  });

  describe('idempotence and the trigger DDL', () => {
    const REDACT = (column: string) => `og_redact_http_dump(${column}, 'password|token')`;

    /** A dump whose redaction shrinks it by a few characters, sized so that the cap falls just inside or outside the result. */
    const dumpOf = (length: number): string => {
      const head = 'POST /x HTTP/1.1\r\nContent-Type: application/json\r\n\r\n';
      const tail = '"password":"abcdefghijkl"}'; // 12 characters become the 10 of [REDACTED]
      return head + 'a'.repeat(Math.max(0, length - head.length - tail.length)) + tail;
    };

    it.each([
      MAX_REDACTED_DUMP_CHARS - 40,
      MAX_REDACTED_DUMP_CHARS - 2,
      MAX_REDACTED_DUMP_CHARS,
      MAX_REDACTED_DUMP_CHARS + 1,
      MAX_REDACTED_DUMP_CHARS + 2,
      MAX_REDACTED_DUMP_CHARS + 60,
      MAX_REDACTED_DUMP_CHARS + 5000,
    ])('redacting a stored dump of %i characters again is a no-op, at the cap too', async (length) => {
      const [row] = await insert([{ req: b64(dumpOf(length)), res: '' }]);
      const id = apiIds[apiIds.length - 1];
      const again = await prisma.$queryRawUnsafe<{ same: boolean; text: string }[]>(
        `SELECT rawrequest = ${REDACT('rawrequest')} AS same, convert_from(decode(${REDACT('rawrequest')}, 'base64'), 'UTF8') AS text
           FROM public.tyk_analytics WHERE apiid = $1`,
        id,
      );
      expect(decodeStrict(row.rawrequest)).not.toContain('abcdefghijkl');
      expect(again[0]?.same).toBe(true);
      // The marker is there once, at the end, and nowhere inside.
      const text = again[0]?.text ?? '';
      expect(text.split(TRUNCATED_DUMP_MARKER).length - 1).toBe(length > MAX_REDACTED_DUMP_CHARS ? 1 : 0);
      if (length > MAX_REDACTED_DUMP_CHARS) expect(text.endsWith(`\n${TRUNCATED_DUMP_MARKER}`)).toBe(true);
      // What was kept never exceeds the cap plus the marker line.
      expect(text.length).toBeLessThanOrEqual(MAX_REDACTED_DUMP_CHARS + 1 + TRUNCATED_DUMP_MARKER.length);
    });

    it('a re-install with an intact trigger issues no trigger DDL at all: the trigger keeps its identity', async () => {
      const oid = async (): Promise<string> =>
        (await prisma.$queryRaw<{ oid: string }[]>`SELECT oid::text AS oid FROM pg_trigger WHERE tgname = 'og_redact_tyk_analytics_trg' AND NOT tgisinternal`)[0]?.oid ?? '';
      const before = await oid();
      await service.onModuleInit();
      await scheduler.purgeExpiredAnalytics();
      expect(await oid()).toBe(before); // DROP + CREATE would have made a new one
    });

    it('a trigger that is not BEFORE INSERT FOR EACH ROW on this function is replaced, and the rows it let through are redacted', async () => {
      await prisma.$executeRawUnsafe('DROP TRIGGER og_redact_tyk_analytics_trg ON public.tyk_analytics');
      // An AFTER trigger on the same function exists and is enabled, yet cannot redact what it is shown: the wrong kind.
      await prisma.$executeRawUnsafe(
        'CREATE TRIGGER og_redact_tyk_analytics_trg AFTER INSERT ON public.tyk_analytics FOR EACH ROW EXECUTE FUNCTION og_redact_tyk_analytics()',
      );
      const [leaked] = await insert([{ req: b64(SECRET_DUMP), res: '' }]);
      const leakedId = apiIds[apiIds.length - 1];
      expect(decodeStrict(leaked.rawrequest)).toContain('real-token');

      await service.onModuleInit();

      const kind = await prisma.$queryRaw<{ tgtype: number }[]>`SELECT tgtype::int AS tgtype FROM pg_trigger WHERE tgname = 'og_redact_tyk_analytics_trg' AND NOT tgisinternal`;
      expect(kind).toEqual([{ tgtype: 7 }]);
      const [healed] = await prisma.$queryRaw<Row[]>`SELECT rawrequest, rawresponse FROM public.tyk_analytics WHERE apiid = ${leakedId}`;
      expect(decodeStrict(healed.rawrequest)).not.toContain('real-token');
    });

    it('gives up on a table lock the pump holds after 5 s instead of stalling it, and succeeds once the lock is gone', async () => {
      await prisma.$executeRawUnsafe('ALTER TABLE public.tyk_analytics DISABLE TRIGGER og_redact_tyk_analytics_trg'); // so the DDL must DROP + CREATE it
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      // A pump insert in flight: ROW EXCLUSIVE conflicts with the ACCESS EXCLUSIVE that DROP TRIGGER wants.
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('LOCK TABLE public.tyk_analytics IN ROW EXCLUSIVE MODE');
          locked();
          await held;
        },
        { timeout: 60_000 },
      );
      await lockTaken;

      const started = Date.now();
      await expect(prisma.$queryRawUnsafe(analyticsRedactionDdl(['password', 'token']))).rejects.toThrow(/lock timeout|55P03/i);
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(4_500);
      expect(waited).toBeLessThan(15_000);

      release();
      await holder;
      await expect(prisma.$queryRawUnsafe(analyticsRedactionDdl(['password', 'token']))).resolves.toBeDefined();
      const enabled = await prisma.$queryRaw<{ tgenabled: string }[]>`SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'og_redact_tyk_analytics_trg' AND NOT tgisinternal`;
      expect(enabled).toEqual([{ tgenabled: 'O' }]);
    });
  });

  it('has the partial (apiid, timestamp DESC) index on captured rows, and a captured-rows lookup uses it', async () => {
    const defs = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'tyk_analytics' AND indexname = 'og_tyk_analytics_captured_apiid_ts'`;
    expect(defs).toHaveLength(1);
    expect(defs[0].indexdef).toContain(
      '(apiid, "timestamp" DESC) WHERE ((rawrequest <> \'\'::text) OR (rawresponse <> \'\'::text))',
    );

    // The traffic inspector's query shape (AC-LOG02.4's "captured"); seqscan off so the tiny fixture
    // table cannot hide an unusable predicate behind a cheaper full scan. Analyzed first: there are now two partial indexes
    // on the captured rows (this one, and the timestamp-only one the search indexer reads), and without statistics the
    // planner has no reason to prefer the one that also matches the apiid.
    await prisma.$executeRawUnsafe('ANALYZE public.tyk_analytics');
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRaw<{ 'QUERY PLAN': string }[]>`
        EXPLAIN SELECT "timestamp" FROM public.tyk_analytics
        WHERE apiid = ${apiIds[0]} AND (rawrequest <> '' OR rawresponse <> '') ORDER BY "timestamp" DESC LIMIT 50`;
    });
    expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain('og_tyk_analytics_captured_apiid_ts');
  });

  // Last on purpose: its bulk insert/delete changes the table statistics, which the planner-sensitive
  // index test above would otherwise see.
  it('an ordinary batch costs about the same as before containers were handled: 1200 small rows in seconds, not minutes', async () => {
    // Measured when container redaction was first added without a guard: 0.25 ms -> 10.7 ms per dump
    // (x2 columns), i.e. ~24 s for this batch and a stalled pump. The guard skips the bracket passes
    // unless a listed field is followed by `{` or `[`.
    const dump = b64('POST /orders HTTP/1.1\r\nHost: gw\r\n\r\n{"user":"bob","note":"refund declined","amount":120,"items":[{"sku":"A1","qty":2}]}');
    const started = Date.now();
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.tyk_analytics (apiid, apikey, rawrequest, rawresponse)
       SELECT 'batch-' || g, 'k', $1, $1 FROM generate_series(1, 1200) g`,
      dump,
    );
    const elapsedMs = Date.now() - started;
    await prisma.$executeRawUnsafe(`DELETE FROM public.tyk_analytics WHERE apiid LIKE 'batch-%'`);

    expect(elapsedMs).toBeLessThan(8_000); // ~0.6 s measured after the guard; 24 s without it
  });
});
