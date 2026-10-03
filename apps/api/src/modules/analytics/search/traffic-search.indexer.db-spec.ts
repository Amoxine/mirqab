import '../../../common/testing/throwaway-db.guard'; // must stay first: refuses to load against the stack database
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { prisma } from '@open-gateway/database';
import type { RedisService } from '../../../common/redis/redis.service';
import { AnalyticsService } from '../services/analytics.service';
import type { PumpHealthService } from '../services/pump-health.service';
import { REDACTION_TRIGGER } from '../services/pump-query.builder';
import * as searchRow from './traffic-search.row';
import { MULTIPART_PLACEHOLDER, OPAQUE_BODY_PLACEHOLDER, UNREDACTABLE_BODY_PLACEHOLDER } from './traffic-search.row';
import { TrafficSearchIndexerService } from './traffic-search.indexer.service';
import { capturedPageSql } from './traffic-search.page-query';
import { trafficSearchQuery } from './traffic-search.query.builder';
import { readState, resetProjection, TAG_PENDING } from './traffic-search.state';
import { TrafficSearchStoreService } from './traffic-search.store.service';
import { validateSearchRequest } from './traffic-search.validate';

/**
 * The indexer against a REAL Postgres: the pump table with the real redaction trigger in front of it,
 * the real search table, and the real compiled search query. Not part of `jest` (the name does not
 * match `.spec.ts`): it needs a THROWAWAY database — never the stack's.
 *
 *   docker run -d --rm --name og-probe-search-pg -e POSTGRES_USER=t -e POSTGRES_PASSWORD=t \
 *     -e POSTGRES_DB=t -p 127.0.0.1:55451:5432 postgres:16-alpine
 *   export OG_THROWAWAY_DATABASE_URL='postgresql://t:t@127.0.0.1:55451/t?schema=public'
 *   (cd apps/api && DATABASE_URL=$OG_THROWAWAY_DATABASE_URL npx jest --runInBand --testRegex 'traffic-search\.indexer\.db-spec\.ts$')
 *   docker rm -f og-probe-search-pg
 *
 * `apiDefinition` is stubbed (it needs the migrated app schema, which the pump-table specs do without);
 * everything else, including the trigger and the partitions, is the real thing.
 */

jest.setTimeout(120_000);

const NOW = new Date('2026-09-29T12:00:00.000Z');
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

const SECRETS = {
  bearer: 'PLANTED-BEARER',
  cookie: 'PLANTED-COOKIE',
  password: 'PLANTED-PASSWORD',
  nested: 'PLANTED-NESTED-SID',
  tenantHeader: 'PLANTED-TENANT-HDR',
  qsToken: 'PLANTED-QS-TOKEN',
  resToken: 'PLANTED-RES-TOKEN',
  multipart: 'PLANTED-MULTIPART',
};

const SECRET_REQUEST = [
  `POST /orders?access_token=${SECRETS.qsToken}&page=2 HTTP/1.1`,
  'Host: gw',
  `Authorization: Bearer ${SECRETS.bearer}`,
  `Cookie: sid=${SECRETS.cookie}`,
  `X-Tenant-Ref: ${SECRETS.tenantHeader}`,
  'X-Request-Id: req-visible-1',
  'Content-Type: application/json',
  '',
  `{"user":"bob","password":"${SECRETS.password}","note":"refund declined"}`,
].join('\r\n');
const SECRET_RESPONSE = [
  'HTTP/1.1 402 Payment Required',
  'Content-Type: application/json',
  '',
  `{"cookies":{"sid":"${SECRETS.nested}"},"refresh_token":"${SECRETS.resToken}","error":"insufficient funds"}`,
].join('\r\n');
const MULTIPART_REQUEST = [
  'POST /upload HTTP/1.1',
  'Content-Type: multipart/form-data; boundary=xyz',
  '',
  `--xyz\r\nContent-Disposition: form-data; name="f"\r\n\r\n${SECRETS.multipart}\r\n--xyz--`,
].join('\r\n');

describe('traffic search indexer on a real Postgres', () => {
  const config = { get: (_k: string, fallback?: unknown) => fallback } as unknown as ConfigService;
  const apis = [{ tykApiId: 'tyk-a', config: { authHeaderName: 'X-Tenant-Ref' } }];
  const stubbed = new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === 'apiDefinition') return { findMany: () => Promise.resolve(apis) };
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const store = new TrafficSearchStoreService(stubbed, config);
  const indexer = new TrafficSearchIndexerService(stubbed, config, store);

  const count = async (): Promise<number> => Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM public.og_traffic_search`)[0]?.n);
  /** `path` is the pump's own column (what the search shows and matches), not the request line inside the dump. */
  const pumpRow = (ts: string, key: string, req: string | null, res: string | null, apiid = 'tyk-a', path = '/orders') =>
    prisma.$executeRawUnsafe(
      `INSERT INTO public.tyk_analytics ("timestamp", apiid, apikey, alias, ipaddress, method, path, responsecode, latency_total, requesttime, rawrequest, rawresponse)
       VALUES ($1::timestamptz, $2, $3, 'qbus-web', '10.0.0.7', 'POST', $6, 402, 340, 12, $4, $5)`,
      ts,
      apiid,
      key,
      req === null ? '' : b64(req),
      res === null ? '' : b64(res),
      path,
    );
  const search = async (clauses: Record<string, unknown>[]) => {
    const request = validateSearchRequest({ range: '7d', clauses });
    const q = trafficSearchQuery({ request, tykApiIds: ['tyk-a'], resolveApi: () => [], now: NOW });
    return prisma.$queryRawUnsafe<{ id: bigint }[]>(q.text, ...q.values);
  };

  beforeAll(async () => {
    Logger.overrideLogger(false);
    const url = process.env.DATABASE_URL;
    if (!url || url !== process.env.OG_THROWAWAY_DATABASE_URL || url.includes(':33002')) {
      throw new Error('Refusing to run: DATABASE_URL must equal OG_THROWAWAY_DATABASE_URL and must not be the stack database');
    }
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS public.og_traffic_search, public.og_traffic_search_state, public.tyk_analytics CASCADE');
    await prisma.$executeRawUnsafe('DROP SEQUENCE IF EXISTS public.og_traffic_search_id_seq');
    await prisma.$executeRawUnsafe(`
      CREATE TABLE public.tyk_analytics (
        "timestamp" timestamptz, apiid text, apikey text, alias text, ipaddress text, method text, path text,
        responsecode bigint, latency_total bigint, requesttime bigint, rawrequest text, rawresponse text)`);
    // The real trigger and indexes, installed the way the API installs them at boot.
    const analytics = new AnalyticsService(prisma, {} as RedisService, {} as PumpHealthService, config);
    await analytics.onModuleInit();
    await store.maintain(NOW);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS public.og_traffic_search, public.og_traffic_search_state, public.tyk_analytics CASCADE');
    await prisma.$disconnect();
  });

  it('indexes captured rows once: a rescan inserts nothing and the watermark is set', async () => {
    await pumpRow('2026-09-29T10:00:00.123456Z', 'k1', SECRET_REQUEST, SECRET_RESPONSE);
    await pumpRow('2026-09-29T10:00:01Z', 'k2', MULTIPART_REQUEST, 'HTTP/1.1 200 OK\r\n\r\nok');
    await pumpRow('2026-09-29T10:00:02Z', 'k3', null, null); // not captured: no dump

    const first = await indexer.scan(new Date('2026-09-29T00:00:00Z'), NOW, true);
    expect(first).toEqual({ inserted: 2, skipped: 0, reason: 'ok' });
    expect(await count()).toBe(2);
    expect(await indexer.scan(new Date('2026-09-29T00:00:00Z'), NOW, true)).toEqual({ inserted: 0, skipped: 0, reason: 'ok' });
    expect(await count()).toBe(2);
    expect((await indexer.indexedUntil())?.toISOString()).toBe(NOW.toISOString());
    // And it says where its coverage starts: the window of the first scan, for a search that reaches back further.
    expect((await indexer.indexedFrom())?.toISOString()).toBe('2026-09-29T00:00:00.000Z');
  });

  it('keeps the microseconds of the pump timestamp', async () => {
    const rows = await prisma.$queryRaw<{ t: string }[]>`
      SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS t FROM public.og_traffic_search WHERE key_alias = 'qbus-web' ORDER BY ts LIMIT 1`;
    expect(rows[0]?.t).toBe('2026-09-29T10:00:00.123456');
  });

  it('planted secrets are in no column, found by no clause, and the multipart body is a placeholder', async () => {
    const dump = (await prisma.$queryRaw<{ j: string }[]>`SELECT row_to_json(t)::text AS j FROM public.og_traffic_search t`).map((r) => r.j).join('\n');
    for (const secret of Object.values(SECRETS)) expect(dump).not.toContain(secret);
    expect(dump).toContain(MULTIPART_PLACEHOLDER);

    // The same through the real compiled search: no word clause, on either side, finds a secret word.
    for (const word of ['PLANTED-BEARER', 'PLANTED-PASSWORD', 'PLANTED-NESTED-SID', 'PLANTED-TENANT-HDR', 'PLANTED-QS-TOKEN', 'PLANTED-MULTIPART']) {
      expect(await search([{ kind: 'body', side: 'any', value: word }])).toHaveLength(0);
    }
    // And no header clause matches a redacted value.
    expect(await search([{ kind: 'header', side: 'req', name: 'x-tenant-ref', value: SECRETS.tenantHeader }])).toHaveLength(0);
  });

  it('positive controls: what is not secret is findable, and a redacted header still says it was sent', async () => {
    expect(await search([{ kind: 'body', side: 'res', value: 'insufficient funds' }])).toHaveLength(1);
    expect(await search([{ kind: 'body', side: 'req', value: 'refund declined' }])).toHaveLength(1);
    expect(await search([{ kind: 'body', side: 'req', value: 'insufficient funds' }])).toHaveLength(0);
    expect(await search([{ kind: 'header', side: 'req', name: 'x-request-id', value: 'req-visible-1' }])).toHaveLength(1);
    expect(await search([{ kind: 'header', side: 'req', name: 'authorization' }])).toHaveLength(1);
    expect(await search([{ kind: 'status', match: { type: 'cmp', op: '>=', value: 400 } }, { kind: 'key', value: 'qbus-web' }])).toHaveLength(2);
  });

  it('picks up a record the pump delivered late, inside the lookback', async () => {
    await pumpRow('2026-09-29T11:55:00Z', 'late', 'GET /late HTTP/1.1\r\n\r\n', 'HTTP/1.1 200 OK\r\n\r\nlate arrival');
    const before = await count();
    const outcome = await indexer.tick(new Date('2026-09-29T12:01:00Z'));
    expect(outcome).toEqual({ inserted: 1, skipped: 0, reason: 'ok' });
    expect(await count()).toBe(before + 1);
  });

  it('pages across identical timestamps without skipping or repeating a row', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.tyk_analytics ("timestamp", apiid, apikey, alias, method, path, responsecode, latency_total, requesttime, rawrequest, rawresponse)
       SELECT '2026-09-29T09:00:00Z', 'tyk-a', 'tie' || g, 'qbus-web', 'GET', '/tie', 200, 1, g, $1, $2 FROM generate_series(1, 1500) g`,
      b64('GET /tie HTTP/1.1\r\n\r\n'),
      b64('HTTP/1.1 200 OK\r\n\r\ntie'),
    );
    const before = await count();
    const started = Date.now();
    await indexer.scan(new Date('2026-09-29T08:00:00Z'), NOW, false);
    expect(await count()).toBe(before + 1500); // 1500 ties across three 500-row pages
    // Neither table has statistics here, so the planner compares every tie with every other (a nested loop). It used to
    // evaluate the dedupe key per PAIR: 885,000 sha256 for 1,330 ties, 29 s a page, and every later scan paid it again.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('does not index a row older than the retention window', async () => {
    await pumpRow('2026-08-01T10:00:00Z', 'old', 'GET /old HTTP/1.1\r\n\r\n', 'HTTP/1.1 200 OK\r\n\r\nancient');
    const before = await count();
    await indexer.scan(new Date('2026-07-30T00:00:00Z'), NOW, false);
    expect(await count()).toBe(before);
    expect(await search([{ kind: 'body', side: 'any', value: 'ancient' }])).toHaveLength(0);
  });

  it('pauses without the redaction trigger, and resumes when it is back', async () => {
    await prisma.$executeRawUnsafe(`ALTER TABLE public.tyk_analytics DISABLE TRIGGER ${REDACTION_TRIGGER}`);
    await pumpRow('2026-09-29T11:58:00Z', 'untrusted', 'GET /raw HTTP/1.1\r\nAuthorization: Bearer UNTRUSTED-TOKEN\r\n\r\n', 'HTTP/1.1 200 OK\r\n\r\nrow while unprotected');
    const before = await count();
    // `paused` is a reason of its own: a bare 0 is also what a failed scan returned.
    expect(await indexer.scan(new Date('2026-09-29T11:00:00Z'), NOW, false)).toEqual({ inserted: 0, skipped: 0, reason: 'paused' });
    expect(await count()).toBe(before);

    await prisma.$executeRawUnsafe(`ALTER TABLE public.tyk_analytics ENABLE ALWAYS TRIGGER ${REDACTION_TRIGGER}`);
    const resumed = await indexer.scan(new Date('2026-09-29T11:00:00Z'), NOW, false);
    expect(resumed.reason).toBe('ok');
    expect(resumed.inserted).toBeGreaterThan(0);
  });

  it('parses only rows it has not indexed yet, and yields to the event loop while it parses', async () => {
    // Each row "costs" 1 ms, so a page of 120 is well over one 20 ms slice: the loop must give the event loop back by time.
    const realBuild = searchRow.buildSearchRow;
    const parse = jest.spyOn(searchRow, 'buildSearchRow').mockImplementation((row, auth) => {
      const end = performance.now() + 1;
      while (performance.now() < end) {
        // busy: stands in for a hostile dump
      }
      return realBuild(row, auth);
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.tyk_analytics ("timestamp", apiid, apikey, alias, method, path, responsecode, latency_total, requesttime, rawrequest, rawresponse)
       SELECT '2026-09-29T11:59:00Z', 'tyk-a', 'fresh' || g, 'qbus-web', 'GET', '/fresh', 200, 1, g, $1, $2 FROM generate_series(1, 120) g`,
      b64('GET /fresh HTTP/1.1\r\n\r\n'),
      b64('HTTP/1.1 200 OK\r\n\r\nfresh'),
    );
    // A probe that re-arms itself on every event-loop turn and records how many rows had been parsed when it ran.
    const seen: number[] = [];
    let scanning = true;
    const probe = (): void => {
      seen.push(parse.mock.calls.length);
      if (scanning) setImmediate(probe);
    };
    setImmediate(probe);

    // The window holds every row indexed so far today (1,200 ties, the late one, ...): none is read back or parsed.
    const outcome = await indexer.scan(new Date('2026-09-29T00:00:00Z'), NOW, false);
    scanning = false;
    expect(outcome.inserted).toBe(120);
    expect(parse).toHaveBeenCalledTimes(120);
    // The probe ran between two rows of the same page: parsing gave the event loop back mid-page.
    expect(seen.some((n) => n > 0 && n < 120)).toBe(true);

    parse.mockClear();
    expect((await indexer.scan(new Date('2026-09-29T00:00:00Z'), NOW, false)).inserted).toBe(0);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  describe('what a hostile or unusual capture cannot do to the table', () => {
    const rowsBy = async (clauses: Record<string, unknown>[]) => {
      const request = validateSearchRequest({ range: '7d', clauses });
      const q = trafficSearchQuery({ request, tykApiIds: ['tyk-a'], resolveApi: () => [], now: NOW });
      return prisma.$queryRawUnsafe<{ id: bigint; path: string; key_alias: string }[]>(q.text, ...q.values);
    };

    it('a row the table refuses (a NUL that got past the row builder) is skipped and counted: the rest of its batch lands and the watermark moves on', async () => {
      for (let i = 0; i < 6; i += 1) await pumpRow(`2026-09-29T08:00:0${String(i)}Z`, `poison${String(i)}`, `GET /poison/${String(i)} HTTP/1.1\r\n\r\n`, 'HTTP/1.1 200 OK\r\n\r\nbatch survives', 'tyk-a', `/poison/${String(i)}`);
      const before = await count();
      // Past the builder's own cleaning, to prove the second line of defence: one row of the page carries a NUL.
      const real = searchRow.buildSearchRow;
      const spy = jest.spyOn(searchRow, 'buildSearchRow').mockImplementation((row, auth) => {
        const built = real(row, auth);
        return row.apikey === 'poison3' ? { ...built, resBody: 'bad\u0000body' } : built;
      });
      const end = new Date('2026-09-29T12:05:00Z');
      const outcome = await indexer.scan(new Date('2026-09-29T07:00:00Z'), end, true);
      spy.mockRestore();

      expect(outcome).toEqual({ inserted: 5, skipped: 1, reason: 'ok' });
      expect(await count()).toBe(before + 5);
      expect((await indexer.indexedUntil())?.toISOString()).toBe(end.toISOString()); // not stuck behind the bad row
      expect(await rowsBy([{ kind: 'path', value: '/poison/3' }])).toHaveLength(0);
      expect(await rowsBy([{ kind: 'path', value: '/poison/2' }])).toHaveLength(1);
      // The same row is not offered to the table again by the next tick.
      expect((await indexer.scan(new Date('2026-09-29T07:00:00Z'), end, true)).skipped).toBe(0);
    });

    it('an emoji cut in half by the header, name and body limits is stored well formed: nothing for the table to refuse', async () => {
      const emoji = '😀';
      // The trigger caps a whole dump at 16,384 characters (code points); the row builder caps a body at 16,384 UTF-16 units.
      // 8,192 emoji are 16,384 units in 8,192 characters, so the body passes the first and is cut by the second, inside an emoji.
      const body = `a${emoji.repeat(8192)}`;
      await pumpRow(
        '2026-09-29T08:10:00Z',
        'astral',
        `POST /astral HTTP/1.1\r\nX-Cut: ${'v'.repeat(999)}${emoji}\r\n${'n'.repeat(99)}${emoji}: x\r\nContent-Type: application/json\r\n\r\n${body}`,
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${body}`,
        'tyk-a',
        '/astral',
      );
      const outcome = await indexer.scan(new Date('2026-09-29T08:00:00Z'), new Date('2026-09-29T12:06:00Z'), false);
      expect(outcome).toMatchObject({ inserted: 1, skipped: 0, reason: 'ok' });
      const stored = await prisma.$queryRaw<{ ok: boolean }[]>`
        SELECT (convert_to(req_body, 'UTF8') IS NOT NULL AND convert_to(res_body, 'UTF8') IS NOT NULL
                AND length(req_body) = 8193 AND right(req_body, 1) = chr(65533) -- 'a', 8,191 whole emoji, and the half of one that was cut
                AND length(res_body) = 8193 AND right(res_body, 1) = chr(65533)
                AND (req_headers -> 'x-cut') IS NOT NULL) AS ok
          FROM public.og_traffic_search WHERE path = '/astral'`;
      expect(stored).toEqual([{ ok: true }]);
    });

    const LEAKY: [string, string, string, string][] = [
      ['newline-separated key=value', 'text/plain', 'user=bob\npassword=PLANTED-NL-PW\nnote=hi', 'PLANTED-NL-PW'],
      ['space-separated pairs', 'text/plain', 'user=bob password=PLANTED-SP-PW', 'PLANTED-SP-PW'],
      ['an XML element', 'application/xml', '<user><Password>PLANTED-XML-PW</Password></user>', 'PLANTED-XML-PW'],
      ['a YAML line', 'application/yaml', 'password: PLANTED-YAML-PW\nname: bob', 'PLANTED-YAML-PW'],
      ['JSON sent as text/plain', 'text/plain', '{"password":"PLANTED-JSON-AS-TEXT"}', 'PLANTED-JSON-AS-TEXT'],
    ];

    it.each(LEAKY)('%s: the body is a placeholder, and no clause on any side finds the secret', async (name, type, body, secret) => {
      const slug = name.replace(/\W+/g, '-');
      await pumpRow(
        '2026-09-29T08:20:00Z',
        `shape-${slug}`,
        `POST /shape/${slug}?access_token=PLANTED-QS-${slug} HTTP/1.1\r\nContent-Type: ${type}\r\n\r\n${body}`,
        `HTTP/1.1 200 OK\r\nContent-Type: ${type}\r\n\r\n${body}`,
        'tyk-a',
        `/shape/${slug}?access_token=PLANTED-QS-${slug}`,
      );
      await indexer.scan(new Date('2026-09-29T08:00:00Z'), new Date('2026-09-29T12:07:00Z'), false);

      const dump = (await prisma.$queryRaw<{ j: string }[]>`SELECT row_to_json(t)::text AS j FROM public.og_traffic_search t WHERE path LIKE ${`/shape/${slug}%`}`).map((r) => r.j).join('\n');
      expect(dump).toContain(OPAQUE_BODY_PLACEHOLDER);
      expect(dump).not.toContain(secret);
      expect(dump).not.toContain('PLANTED-QS');
      for (const side of ['any', 'req', 'res'] as const) expect(await rowsBy([{ kind: 'body', side, value: secret }])).toHaveLength(0);
      for (const word of secret.split('-')) if (word.length >= 3 && word !== 'PLANTED') expect(await rowsBy([{ kind: 'body', side: 'any', value: word }])).toHaveLength(0);
      // The same words, as a form or JSON, would have been redacted by name; here the whole body is not indexed.
      expect(await rowsBy([{ kind: 'path', value: `/shape/${slug}` }, { kind: 'body', side: 'any', value: 'bob' }])).toHaveLength(0);
    });

    it('JSON and form bodies are still searchable, with their secrets redacted by name', async () => {
      await pumpRow(
        '2026-09-29T08:30:00Z',
        'json-and-form',
        'POST /json-form HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"password":"PLANTED-JSON-FIELD","note":"visibleword"}',
        'HTTP/1.1 200 OK\r\nContent-Type: application/x-www-form-urlencoded\r\n\r\nuser=bob&password=PLANTED-FORM-FIELD&memo=formvisible',
      );
      await indexer.scan(new Date('2026-09-29T08:00:00Z'), new Date('2026-09-29T12:08:00Z'), false);
      expect(await rowsBy([{ kind: 'body', side: 'req', value: 'visibleword' }])).toHaveLength(1);
      expect(await rowsBy([{ kind: 'body', side: 'res', value: 'formvisible' }])).toHaveLength(1);
      for (const secret of ['PLANTED-JSON-FIELD', 'PLANTED-FORM-FIELD']) expect(await rowsBy([{ kind: 'body', side: 'any', value: secret }])).toHaveLength(0);
    });

    it('a capture the trigger could not decode is stored with a visible placeholder, and "has no X header" does not claim it', async () => {
      const gzip = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0xc3, 0x28]).toString('base64');
      await prisma.$executeRawUnsafe(
        `INSERT INTO public.tyk_analytics ("timestamp", apiid, apikey, alias, ipaddress, method, path, responsecode, latency_total, requesttime, rawrequest, rawresponse)
         VALUES ('2026-09-29T08:40:00Z', 'tyk-a', 'gz', 'qbus-web', '10.0.0.7', 'POST', '/gz', 200, 5, 1, $1, $2)`,
        gzip,
        b64('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}'),
      );
      await indexer.scan(new Date('2026-09-29T08:00:00Z'), new Date('2026-09-29T12:09:00Z'), false);

      const row = await prisma.$queryRaw<{ unredactable: boolean; req_body: string; req_headers: unknown }[]>`SELECT unredactable, req_body, req_headers FROM public.og_traffic_search WHERE path = '/gz'`;
      expect(row).toEqual([{ unredactable: true, req_body: UNREDACTABLE_BODY_PLACEHOLDER, req_headers: {} }]);
      // Rows that really sent no such header are found; this one, whose headers were never read, is not.
      const without = await rowsBy([{ kind: 'header', neg: true, side: 'req', name: 'x-never-sent' }]);
      expect(without.some((r) => r.path === '/gz')).toBe(false);
      expect(without.length).toBeGreaterThan(0);
      // And the placeholder can be seen, so the row does not look like an empty request.
      expect(await rowsBy([{ kind: 'body', side: 'req', value: 'UNREDACTABLE' }])).toHaveLength(1);
    });
  });

  describe('where a page starts, and what a rebuild covers', () => {
    interface PlanNode {
      'Node Type': string;
      'Relation Name'?: string;
      'Actual Rows': number;
      'Actual Loops': number;
      Plans?: PlanNode[];
    }
    const rowsBy = async (clauses: Record<string, unknown>[]) => {
      const request = validateSearchRequest({ range: '30d', clauses });
      const q = trafficSearchQuery({ request, tykApiIds: ['tyk-a'], resolveApi: () => [], now: NOW });
      return prisma.$queryRawUnsafe<{ id: bigint; path: string }[]>(q.text, ...q.values);
    };

    it('the anti-join reads the projection from the cursor, not from the start of the window, and the pump side uses the partial index', async () => {
      // Nothing from the tests before: rows they left in the projection AFTER the cursor are, rightly, read.
      await prisma.$executeRawUnsafe('DELETE FROM public.og_traffic_search');
      await prisma.$executeRawUnsafe('DELETE FROM public.tyk_analytics');
      await prisma.$executeRawUnsafe(
        `INSERT INTO public.tyk_analytics ("timestamp", apiid, apikey, alias, method, path, responsecode, latency_total, requesttime, rawrequest, rawresponse)
         SELECT '2026-09-20T00:00:00Z'::timestamptz + (g || ' seconds')::interval, 'tyk-explain', 'x' || g, 'qbus-web', 'GET', '/explain', 200, 1, g, $1, $2
           FROM generate_series(1, 4000) g`,
        b64('GET /explain HTTP/1.1\r\n\r\n'),
        b64('HTTP/1.1 200 OK\r\n\r\nexplain'),
      );
      // The projection already holds the first 2,000 of them: a scan half way through its backlog. (The indexer creates the
      // partition of each day it writes to; this insert goes around it.)
      await store.ensurePartitions([new Date('2026-09-20T00:00:00Z')]);
      await prisma.$executeRawUnsafe(
        `INSERT INTO public.og_traffic_search (ts, apiid, method, path, dedupe_key)
         SELECT "timestamp", apiid, method, path, encode(sha256(convert_to(jsonb_build_array(apiid, to_char("timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
                  apikey, method, path, responsecode, latency_total, requesttime)::text, 'UTF8')), 'hex')
           FROM public.tyk_analytics WHERE apiid = 'tyk-explain' ORDER BY "timestamp" LIMIT 2000`,
      );
      await prisma.$executeRawUnsafe('ANALYZE public.tyk_analytics');
      await prisma.$executeRawUnsafe('ANALYZE public.og_traffic_search');
      const from = new Date('2026-09-19T00:00:00Z');
      const cursor = (
        await prisma.$queryRaw<{ ts: string; key: string }[]>`
          SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts, dedupe_key AS key
            FROM public.og_traffic_search WHERE apiid = 'tyk-explain' ORDER BY ts DESC, dedupe_key DESC LIMIT 1`
      ).at(0);
      if (!cursor) throw new Error('no cursor row');

      const projectionRowsRead = async (): Promise<{ read: number; text: string }> => {
        const q = capturedPageSql(from, NOW, cursor);
        const plan = await prisma.$transaction(async (tx) => {
          // The merge join that reads the projection in order: the plan in which an unbounded side is expensive.
          await tx.$executeRawUnsafe('SET LOCAL enable_nestloop = off');
          await tx.$executeRawUnsafe('SET LOCAL enable_hashjoin = off');
          const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(`EXPLAIN (ANALYZE, FORMAT JSON) ${q.text}`, ...q.values);
          const json = rows[0]?.['QUERY PLAN']; // the driver hands json back already parsed
          return (typeof json === 'string' ? JSON.parse(json) : json) as { Plan: PlanNode }[];
        });
        const text = JSON.stringify(plan, null, 1);
        const reads: number[] = [];
        const walk = (node: PlanNode): void => {
          if (/^og_traffic_search_\d{8}$/.test(node['Relation Name'] ?? '') && node['Node Type'].includes('Scan')) reads.push(node['Actual Rows'] * node['Actual Loops']);
          for (const child of node.Plans ?? []) walk(child);
        };
        for (const p of plan) walk(p.Plan);
        return { read: reads.reduce((a, b) => a + b, 0), text };
      };

      // The 2,000 rows indexed before the cursor are not read at all; the unbounded version read every one of them.
      const { read, text } = await projectionRowsRead();
      if (read >= 200) throw new Error(`the anti-join read ${String(read)} projection rows:\n${text}`);

      const pumpPlan = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off'); // a small table must not hide an unusable index behind a cheaper scan
        const q = capturedPageSql(from, NOW, null);
        return (await tx.$queryRawUnsafe<Record<string, string>[]>(`EXPLAIN ${q.text}`, ...q.values)).map((r) => r['QUERY PLAN']).join('\n');
      });
      expect(pumpPlan).toContain('og_tyk_analytics_captured_ts');
      await prisma.$executeRawUnsafe(`DELETE FROM public.og_traffic_search WHERE apiid = 'tyk-explain'`);
      await prisma.$executeRawUnsafe(`DELETE FROM public.tyk_analytics WHERE apiid = 'tyk-explain'`);
    });

    it('after a reset the rebuild reaches the whole retention window, not the first-run backfill, and a scan from before the reset cannot write after it', async () => {
      // 10 days old: inside the 30-day retention, outside the 7-day first-run backfill.
      await pumpRow('2026-09-19T10:00:00Z', 'ten-days', 'GET /ten-days HTTP/1.1\r\n\r\n', 'HTTP/1.1 200 OK\r\n\r\nolder than the backfill', 'tyk-a', '/ten-days');
      await indexer.tick(NOW);
      expect(await rowsBy([{ kind: 'path', value: '/ten-days' }])).toHaveLength(0); // not covered yet: the lookback is 15 minutes

      const before = await readState(prisma);
      await resetProjection(prisma, 30, TAG_PENDING);
      const after = await readState(prisma);
      expect(after?.generation).toBe((before?.generation ?? 0) + 1);
      expect(after?.indexedFrom).toBeNull(); // nothing covered until the rebuild says so
      expect(await count()).toBe(0);

      // A scan that read the old generation writes nothing into the emptied table...
      const stale = new TrafficSearchIndexerService(stubbed, config, store) as unknown as {
        insertBatch: (rows: searchRow.SearchRow[], generation: number) => Promise<number>;
      };
      const row = searchRow.buildSearchRow(
        { ts_iso: '2026-09-29T09:00:00.000000Z', apiid: 'tyk-a', apikey: 'k', alias: 'a', ipaddress: '1', method: 'GET', path: '/stale', responsecode: 200, latency_total: 1, rawrequest: null, rawresponse: null, dedupe_key: 'stale-key' },
        null,
      );
      expect(await stale.insertBatch([row], before?.generation ?? 0)).toBe(0);
      expect(await count()).toBe(0);
      // ...and one under the current generation does.
      expect(await stale.insertBatch([row], after?.generation ?? 0)).toBe(1);
      await prisma.$executeRawUnsafe(`DELETE FROM public.og_traffic_search`);

      // The rebuild: from the retention floor (30 days), adopting the installer's pending tag instead of resetting again.
      const outcome = await indexer.tick(NOW);
      expect(outcome.reason).toBe('ok');
      expect(await rowsBy([{ kind: 'path', value: '/ten-days' }])).toHaveLength(1);
      const rebuilt = await readState(prisma);
      expect(rebuilt?.generation).toBe(after?.generation); // adopted, not reset a second time
      expect(rebuilt?.redactionTag).not.toBe(TAG_PENDING);
      const from = await indexer.indexedFrom();
      expect(from && from.getTime() <= new Date('2026-09-19T00:00:00Z').getTime()).toBe(true);
    });
  });
});
