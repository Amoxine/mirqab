import '../../../common/testing/throwaway-db.guard'; // must stay first: refuses to load against the stack database
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { prisma } from '@open-gateway/database';
import type { RedisService } from '../../../common/redis/redis.service';
import { AnalyticsService } from '../services/analytics.service';
import type { PumpHealthService } from '../services/pump-health.service';
import { REDACTION_TRIGGER } from '../services/pump-query.builder';
import * as searchRow from './traffic-search.row';
import { MULTIPART_PLACEHOLDER } from './traffic-search.row';
import { TrafficSearchIndexerService } from './traffic-search.indexer.service';
import { trafficSearchQuery } from './traffic-search.query.builder';
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
  const pumpRow = (ts: string, key: string, req: string | null, res: string | null, apiid = 'tyk-a') =>
    prisma.$executeRawUnsafe(
      `INSERT INTO public.tyk_analytics ("timestamp", apiid, apikey, alias, ipaddress, method, path, responsecode, latency_total, requesttime, rawrequest, rawresponse)
       VALUES ($1::timestamptz, $2, $3, 'qbus-web', '10.0.0.7', 'POST', '/orders', 402, 340, 12, $4, $5)`,
      ts,
      apiid,
      key,
      req === null ? '' : b64(req),
      res === null ? '' : b64(res),
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
    expect(first).toBe(2);
    expect(await count()).toBe(2);
    expect(await indexer.scan(new Date('2026-09-29T00:00:00Z'), NOW, true)).toBe(0);
    expect(await count()).toBe(2);
    expect((await indexer.indexedUntil())?.toISOString()).toBe(NOW.toISOString());
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
    const inserted = await indexer.tick(new Date('2026-09-29T12:01:00Z'));
    expect(inserted).toBe(1);
    expect(await count()).toBe(before + 1);
  });

  it('pages across identical timestamps without skipping or repeating a row', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.tyk_analytics ("timestamp", apiid, apikey, alias, method, path, responsecode, latency_total, requesttime, rawrequest, rawresponse)
       SELECT '2026-09-29T09:00:00Z', 'tyk-a', 'tie' || g, 'qbus-web', 'GET', '/tie', 200, 1, g, $1, $2 FROM generate_series(1, 1200) g`,
      b64('GET /tie HTTP/1.1\r\n\r\n'),
      b64('HTTP/1.1 200 OK\r\n\r\ntie'),
    );
    const before = await count();
    await indexer.scan(new Date('2026-09-29T08:00:00Z'), NOW, false);
    expect(await count()).toBe(before + 1200); // 1200 ties across three 500-row pages
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
    expect(await indexer.scan(new Date('2026-09-29T11:00:00Z'), NOW, false)).toBe(0);
    expect(await count()).toBe(before);

    await prisma.$executeRawUnsafe(`ALTER TABLE public.tyk_analytics ENABLE ALWAYS TRIGGER ${REDACTION_TRIGGER}`);
    expect(await indexer.scan(new Date('2026-09-29T11:00:00Z'), NOW, false)).toBeGreaterThan(0);
  });

  it('parses only rows it has not indexed yet, and yields to the event loop while it parses', async () => {
    const parse = jest.spyOn(searchRow, 'buildSearchRow');
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
    const inserted = await indexer.scan(new Date('2026-09-29T00:00:00Z'), NOW, false);
    scanning = false;
    expect(inserted).toBe(120);
    expect(parse).toHaveBeenCalledTimes(120);
    // The probe ran between two rows of the same page: parsing gave the event loop back mid-page.
    expect(seen.some((n) => n > 0 && n < 120)).toBe(true);

    parse.mockClear();
    expect(await indexer.scan(new Date('2026-09-29T00:00:00Z'), NOW, false)).toBe(0);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });
});
