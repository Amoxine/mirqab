import 'reflect-metadata';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AnalyticsRange } from '../dto/analytics-query.dto';
import { analyticsRedactionDdl, REDACTION_TRIGGER } from './pump-query.builder';
import { TRAFFIC_MAX_PAGE_SIZE, TrafficInspectorService } from './traffic-inspector.service';

interface ApiRow {
  id: string;
  tenantId: string;
  tykApiId: string | null;
  config: Prisma.JsonValue;
}

const A_API: ApiRow = { id: 'api-a', tenantId: 'tenant-a', tykApiId: 'tyk-a', config: { detailedRecording: true } };
const B_API: ApiRow = {
  id: 'api-b',
  tenantId: 'tenant-b',
  tykApiId: 'tyk-b',
  config: { detailedRecording: true, authHeaderName: 'X-B-Key' },
};

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

function trafficRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: new Date('2026-09-26T10:00:00Z'),
    method: 'GET',
    path: '/orders',
    responsecode: BigInt(200),
    latency_total: BigInt(12),
    rawrequest: b64('GET /orders?token=qs-secret HTTP/1.1\r\nX-Tenant-Header: hdr-secret\r\n\r\n'),
    rawrequest_clipped: false,
    rawresponse: b64('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}'),
    rawresponse_clipped: false,
    ...overrides,
  };
}

type QueryKind = 'trigger' | 'captured' | 'page';

/** Which of the service's three statements a `Prisma.Sql` is. */
function kindOf(sql: Prisma.Sql): QueryKind {
  if (sql.text.includes('pg_trigger')) return 'trigger';
  if (sql.text.includes('AS captured')) return 'captured';
  return 'page';
}

/** What the database answers. Defaults: trigger installed, nothing captured, empty page. */
interface Pump {
  trigger?: boolean | Error;
  captured?: boolean | Error;
  rows?: unknown[] | Error;
}

/**
 * Prisma double over a two-tenant table: `findFirst` honours `where.id` AND `where.tenantId` the way
 * the real query does, so a lookup that forgot the tenant would find the other tenant's row.
 * `$queryRaw` answers by statement, so a test does not depend on the order they run in.
 */
function makePrisma(apis: ApiRow[] = [A_API, B_API], pump: Pump = {}) {
  const findFirst = jest.fn(({ where }: { where: { id: string; tenantId?: string } }) =>
    Promise.resolve(
      apis.find((api) => api.id === where.id && (where.tenantId === undefined || api.tenantId === where.tenantId)) ??
        null,
    ),
  );
  const $queryRaw = jest.fn((sql: Prisma.Sql): Promise<unknown[]> => {
    const kind = kindOf(sql);
    const answer = kind === 'trigger' ? (pump.trigger ?? true) : kind === 'captured' ? (pump.captured ?? false) : (pump.rows ?? []);
    if (answer instanceof Error) return Promise.reject(answer);
    if (kind === 'trigger') return Promise.resolve([{ present: answer }]);
    if (kind === 'captured') return Promise.resolve([{ captured: answer }]);
    return Promise.resolve(answer as unknown[]);
  });
  return { apiDefinition: { findFirst }, $queryRaw };
}

function makeService(prisma: ReturnType<typeof makePrisma>): TrafficInspectorService {
  return new TrafficInspectorService(prisma as unknown as PrismaClient);
}

/** The SQL text and bound values of every `$queryRaw` call, optionally of one kind only. */
function issued(prisma: ReturnType<typeof makePrisma>, kind?: QueryKind): { text: string; values: unknown[] }[] {
  return prisma.$queryRaw.mock.calls
    .map(([sql]) => sql)
    .filter((sql) => kind === undefined || kindOf(sql) === kind)
    .map((sql) => ({ text: sql.text, values: sql.values }));
}

const kinds = (prisma: ReturnType<typeof makePrisma>): QueryKind[] =>
  prisma.$queryRaw.mock.calls.map(([sql]) => kindOf(sql));

describe('TrafficInspectorService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  describe('tenant scope (AC-LOG02.3)', () => {
    it('resolves the Tyk id from {apiDefId, tenantId} and queries only that id', async () => {
      const prisma = makePrisma();

      await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY);

      expect(prisma.apiDefinition.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'api-a', tenantId: 'tenant-a' } }),
      );
      const [query] = issued(prisma, 'page');
      expect(query.values).toContain('tyk-a');
      expect(query.values).not.toContain('tyk-b');
    });

    it('rejects another tenant’s API with 404 and runs no query at all', async () => {
      const prisma = makePrisma();

      await expect(makeService(prisma).list('tenant-a', 'api-b', AnalyticsRange.ONE_DAY)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('redacts with the owning API’s auth header, not another tenant’s', async () => {
      const prisma = makePrisma(
        [{ ...A_API, config: { detailedRecording: true, authHeaderName: 'X-Tenant-Header' } }, B_API],
        { rows: [trafficRow()] },
      );

      const page = await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY);

      expect(JSON.stringify(page)).not.toContain('hdr-secret');
      expect(JSON.stringify(page)).not.toContain('qs-secret');
    });
  });

  describe('NOT_ENABLED versus an empty page (AC-LOG02.4)', () => {
    it.each([
      ['unset', {}],
      ['explicitly off', { detailedRecording: false }],
      ['config not an object', null],
    ])('recording %s and nothing ever captured → NOT_ENABLED', async (_label, config) => {
      const prisma = makePrisma([{ ...A_API, config }], { captured: false });

      const page = await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY);

      expect(page).toEqual({ status: 'NOT_ENABLED' });
      expect(kinds(prisma)).toEqual(['captured']);
    });

    it('checks "captured" as a non-empty dump, over all time, not "any row exists"', async () => {
      const prisma = makePrisma([{ ...A_API, config: {} }], { captured: false });

      await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_HOUR);

      const [check] = issued(prisma, 'captured');
      expect(check.text).toContain("rawrequest <> ''");
      expect(check.text).toContain("rawresponse <> ''");
      expect(check.text).toContain(' OR ');
      expect(check.values).toEqual(['tyk-a']); // no window bound: old captures still count
    });

    it('recording off but rows captured earlier → shows them, never NOT_ENABLED', async () => {
      const prisma = makePrisma([{ ...A_API, config: { detailedRecording: false } }], {
        captured: true,
        rows: [trafficRow()],
      });

      const page = await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY);

      expect(page).toMatchObject({ status: 'OK', detailedRecording: false, items: [{ path: '/orders' }] });
    });

    it('recording on with nothing captured in the window → an empty OK page', async () => {
      const prisma = makePrisma();

      const page = await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY);

      expect(page).toMatchObject({ status: 'OK', detailedRecording: true, hasMore: false, items: [] });
      expect(kinds(prisma)).toEqual(['trigger', 'page']); // no captured check when recording is on
    });

    it('never-synced API (no Tyk id): NOT_ENABLED when off, empty page when on, never a Pump row read', async () => {
      const off = makePrisma([{ ...A_API, tykApiId: null, config: {} }]);
      const on = makePrisma([{ ...A_API, tykApiId: null }]);

      expect(await makeService(off).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY)).toEqual({
        status: 'NOT_ENABLED',
      });
      expect(await makeService(on).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY)).toMatchObject({
        status: 'OK',
        items: [],
      });
      expect(kinds(off)).toEqual([]);
      expect(kinds(on)).toEqual(['trigger']);
    });
  });

  describe('fails closed without the redaction trigger (security review of T4)', () => {
    it('trigger present → OK with rows', async () => {
      const prisma = makePrisma(undefined, { trigger: true, rows: [trafficRow()] });

      const page = await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY);

      expect(page).toMatchObject({ status: 'OK', items: [{ path: '/orders' }] });
    });

    it('trigger absent → FAILED, no items, and no dump is ever read', async () => {
      const prisma = makePrisma(undefined, { trigger: false, rows: [trafficRow()] });

      const page = await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY);

      expect(page).toEqual({ status: 'FAILED' });
      expect(kinds(prisma)).not.toContain('page');
    });

    it('trigger absent while recording is off but rows were captured → still FAILED', async () => {
      const prisma = makePrisma([{ ...A_API, config: {} }], { trigger: false, captured: true, rows: [trafficRow()] });

      expect(await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY)).toEqual({
        status: 'FAILED',
      });
      expect(kinds(prisma)).toEqual(['captured', 'trigger']);
    });

    it('the trigger check throwing → FAILED, never OK', async () => {
      const prisma = makePrisma(undefined, { trigger: new Error('permission denied for pg_trigger'), rows: [trafficRow()] });

      expect(await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY)).toEqual({
        status: 'FAILED',
      });
      expect(kinds(prisma)).not.toContain('page');
    });

    it('asks for the trigger by name, on tyk_analytics, and only in a state where it fires', async () => {
      const prisma = makePrisma();

      await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY);

      const [check] = issued(prisma, 'trigger');
      expect(check.text).toContain("tgrelid = to_regclass('public.tyk_analytics')");
      expect(check.text).toContain("tgenabled IN ('O', 'A')");
      expect(check.values).toEqual([REDACTION_TRIGGER]);
    });

    it('checks the same trigger name the redaction DDL creates', () => {
      expect(analyticsRedactionDdl(['password'])).toContain(`CREATE TRIGGER ${REDACTION_TRIGGER}`);
    });
  });

  describe('a failed read is FAILED, never an empty page', () => {
    it('when the page query throws', async () => {
      const prisma = makePrisma(undefined, { rows: new Error('relation "tyk_analytics" does not exist') });

      expect(await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY)).toEqual({
        status: 'FAILED',
      });
    });

    it('when the captured check throws (so it cannot pass for NOT_ENABLED either)', async () => {
      const prisma = makePrisma([{ ...A_API, config: {} }], { captured: new Error('connection reset') });

      expect(await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY)).toEqual({
        status: 'FAILED',
      });
    });
  });

  describe('paging and mapping', () => {
    it('bounds the page to the window, newest first, with one extra row for hasMore', async () => {
      const prisma = makePrisma(undefined, { rows: [trafficRow(), trafficRow(), trafficRow()] });
      const before = Date.now();

      const page = await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY, 3, 2);

      const [query] = issued(prisma, 'page');
      expect(query.text).toContain('ORDER BY "timestamp" DESC');
      const from = query.values.find((v): v is Date => v instanceof Date);
      expect(from?.getTime()).toBeGreaterThanOrEqual(before - 24 * 3600 * 1000 - 1000);
      expect(from?.getTime()).toBeLessThanOrEqual(Date.now() - 24 * 3600 * 1000 + 1000);
      expect(query.values.slice(-2)).toEqual([3, 4]); // LIMIT size+1, OFFSET (page-1)*size
      expect(page).toMatchObject({ status: 'OK', page: 3, pageSize: 2, hasMore: true });
      expect(page.status === 'OK' && page.items).toHaveLength(2);
    });

    it('clamps page and page size', async () => {
      const prisma = makePrisma();

      const page = await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY, 0, 10_000);

      expect(page).toMatchObject({ page: 1, pageSize: TRAFFIC_MAX_PAGE_SIZE });
      expect(issued(prisma, 'page')[0].values.slice(-2)).toEqual([TRAFFIC_MAX_PAGE_SIZE + 1, 0]);
    });

    it('maps a row to a redacted, parsed entry and carries the clip flag through', async () => {
      const prisma = makePrisma(
        [{ ...A_API, config: { detailedRecording: true, authHeaderName: 'X-Tenant-Header' } }],
        { rows: [trafficRow({ rawresponse_clipped: true })] },
      );

      const page = await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY);

      expect(page.status === 'OK' && page.items[0]).toEqual({
        timestamp: '2026-09-26T10:00:00.000Z',
        method: 'GET',
        path: '/orders',
        responseCode: 200,
        latencyMs: 12,
        request: {
          startLine: 'GET /orders?token=[REDACTED] HTTP/1.1',
          headers: { 'X-Tenant-Header': '[REDACTED]' },
          body: '',
          truncated: false,
        },
        response: {
          startLine: 'HTTP/1.1 200 OK',
          headers: { 'Content-Type': 'application/json' },
          body: '{"ok":true}',
          truncated: true,
        },
      });
    });

    it('reads only a bounded prefix of each dump column', async () => {
      const prisma = makePrisma();

      await makeService(prisma).list('tenant-a', 'api-a', AnalyticsRange.ONE_DAY);

      const [query] = issued(prisma, 'page');
      expect(query.text).toMatch(/substr\(rawrequest, 1, \$\d+::int\)/);
      expect(query.text).toMatch(/substr\(rawresponse, 1, \$\d+::int\)/);
    });
  });
});
