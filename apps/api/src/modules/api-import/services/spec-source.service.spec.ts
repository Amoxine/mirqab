import { HttpException, Logger } from '@nestjs/common';
import type { ApiSpecSource } from '@prisma/client';
import { SpecFetchError, type SpecFetcherPort } from '../../spec-fetch/spec-fetch.types';
import type { Detection, DetectionAbort, SpecCandidateService } from './spec-candidate.service';
import { backoffMinutes, MAX_SOURCES_PER_TENANT, SpecSourceService, specFetchHttpError } from './spec-source.service';

jest.mock('@open-gateway/database', () => {
  const prisma = {
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    apiDefinition: { findFirst: jest.fn() },
    apiSpecSource: { findFirst: jest.fn(), findMany: jest.fn(), updateMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
  return { prisma };
});

interface Db {
  $queryRaw: jest.Mock;
  apiDefinition: { findFirst: jest.Mock };
  apiSpecSource: Record<'findFirst' | 'findMany' | 'updateMany' | 'count' | 'create' | 'update' | 'deleteMany', jest.Mock>;
}
const { prisma: db } = jest.requireMock<{ prisma: Db }>('@open-gateway/database');

/**
 * OAS-08 source rules with a fake fetcher port and a Prisma mock (mocked evidence). The claim,
 * cooldown and cap against a REAL Postgres are in `spec-source.db-spec.ts`.
 */

const TENANT = 'tenant-a';
const API = 'api-1';
const SECRET_URL = 'https://specs.example.com/openapi.json?token=s3cr3t';
const DB_NOW = new Date('2026-09-25T12:00:00.000Z');

const source = (over: Partial<ApiSpecSource> = {}): ApiSpecSource => ({
  id: 'src-1',
  tenantId: TENANT,
  apiDefId: API,
  url: SECRET_URL,
  enabled: true,
  intervalMinutes: 60,
  nextCheckAt: new Date('2026-09-25T11:59:00.000Z'),
  lastCheckedAt: null,
  lastSuccessAt: null,
  lastResult: null,
  lastErrorCode: null,
  etag: '"old"',
  lastModified: 'Mon, 01 Sep 2026 00:00:00 GMT',
  consecutiveFailures: 0,
  createdAt: DB_NOW,
  updatedAt: DB_NOW,
  ...over,
});

function setup(detection: Detection | DetectionAbort = { result: 'CHANGED' }) {
  const fetcher = { fetch: jest.fn(), validateUrl: jest.fn().mockResolvedValue(undefined) };
  const candidates = {
    detect: jest.fn().mockResolvedValue(detection),
    supersedePending: jest.fn(),
    settleStale: jest.fn(),
    waiting: jest.fn().mockResolvedValue(null),
  };
  const service = new SpecSourceService(fetcher as unknown as SpecFetcherPort, candidates as unknown as SpecCandidateService);
  return { service, fetcher, candidates };
}

/** The data of the result write (the second updateMany: the first is the claim). */
const resultWrite = (): Record<string, unknown> => (db.apiSpecSource.updateMany.mock.calls[1] as [{ data: Record<string, unknown> }])[0].data;

const statusAndCode = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof HttpException ? `${String(e.getStatus())} ${(e.getResponse() as { error?: string }).error ?? ''}` : String(e)),
  );

beforeAll(() => {
  Logger.overrideLogger(false);
});

beforeEach(() => {
  jest.clearAllMocks();
  db.$queryRaw.mockResolvedValue([{ now: DB_NOW }]);
  db.apiDefinition.findFirst.mockResolvedValue({ id: API });
  db.apiSpecSource.updateMany.mockResolvedValue({ count: 1 });
});

describe('SpecSourceService.claimAndCheck — the detection outcomes on the source row', () => {
  it('304: UNCHANGED, keeps the validators, no detection, failures reset', async () => {
    const { service, fetcher, candidates } = setup();
    fetcher.fetch.mockResolvedValue({ kind: 'NOT_MODIFIED' });

    await expect(service.claimAndCheck(source({ consecutiveFailures: 3 }))).resolves.toEqual({ result: 'UNCHANGED' });

    expect(fetcher.fetch).toHaveBeenCalledWith(SECRET_URL, { etag: '"old"', lastModified: 'Mon, 01 Sep 2026 00:00:00 GMT' });
    expect(candidates.detect).not.toHaveBeenCalled();
    expect(candidates.settleStale).toHaveBeenCalledWith(TENANT, API);
    const data = resultWrite();
    expect(data).toMatchObject({ lastResult: 'UNCHANGED', lastErrorCode: null, consecutiveFailures: 0 });
    expect(data).not.toHaveProperty('etag');
  });

  it('review LOW 6: 304 while a proposal waits stays CHANGED (lastResult does not flip to UNCHANGED)', async () => {
    const { service, fetcher, candidates } = setup();
    fetcher.fetch.mockResolvedValue({ kind: 'NOT_MODIFIED' });
    candidates.waiting.mockResolvedValue({ id: 'cand-1', state: 'PENDING' });

    await expect(service.claimAndCheck(source())).resolves.toMatchObject({ result: 'CHANGED', candidate: { id: 'cand-1' } });
    expect(resultWrite()).toMatchObject({ lastResult: 'CHANGED' });
  });

  it('new content: CHANGED, stores the new validators', async () => {
    const { service, fetcher, candidates } = setup({ result: 'CHANGED' });
    fetcher.fetch.mockResolvedValue({ kind: 'OK', text: 'doc', etag: '"new"', lastModified: null });

    await expect(service.claimAndCheck(source())).resolves.toEqual({ result: 'CHANGED' });

    expect(candidates.detect).toHaveBeenCalledWith(TENANT, API, 'doc', SECRET_URL);
    expect(resultWrite()).toMatchObject({ lastResult: 'CHANGED', etag: '"new"', lastModified: null });
  });

  it('same hash / reverted / dismissed content (detect says UNCHANGED): stores the validators of what passed the gates', async () => {
    const { service, fetcher } = setup({ result: 'UNCHANGED' });
    fetcher.fetch.mockResolvedValue({ kind: 'OK', text: 'doc', etag: '"same"', lastModified: null });

    await service.claimAndCheck(source());

    expect(resultWrite()).toMatchObject({ lastResult: 'UNCHANGED', etag: '"same"' });
  });

  it('lint failure: ERROR NOT_A_SPEC and the OLD etag is kept, so the next check re-fetches', async () => {
    const { service, fetcher } = setup({ result: 'ERROR', errorCode: 'NOT_A_SPEC' });
    fetcher.fetch.mockResolvedValue({ kind: 'OK', text: 'not a spec', etag: '"bad"', lastModified: 'x' });

    await expect(service.claimAndCheck(source())).resolves.toEqual({ result: 'ERROR', errorCode: 'NOT_A_SPEC' });

    const data = resultWrite();
    expect(data).toMatchObject({ lastResult: 'ERROR', lastErrorCode: 'NOT_A_SPEC', consecutiveFailures: 1 });
    expect(data).not.toHaveProperty('etag');
    expect(data).not.toHaveProperty('lastModified');
    expect(data).not.toHaveProperty('lastSuccessAt');
  });

  it('a fetch refusal is ERROR SPEC_FETCH_<CODE>; repeated failures back off from the claim time', async () => {
    const { service, fetcher } = setup();
    fetcher.fetch.mockRejectedValue(new SpecFetchError('TIMEOUT'));

    await expect(service.claimAndCheck(source({ consecutiveFailures: 2 }))).resolves.toEqual({ result: 'ERROR', errorCode: 'SPEC_FETCH_TIMEOUT' });

    const data = resultWrite();
    expect(data).toMatchObject({ consecutiveFailures: 3, lastErrorCode: 'SPEC_FETCH_TIMEOUT' });
    expect(data.nextCheckAt).toEqual(new Date(DB_NOW.getTime() + 240 * 60_000));
  });

  it('the claim is a compare-and-set on the next_check_at it read, and advances it BEFORE the fetch (DB clock)', async () => {
    const { service, fetcher } = setup();
    const order: string[] = [];
    db.apiSpecSource.updateMany.mockImplementation(() => {
      order.push('write');
      return Promise.resolve({ count: 1 });
    });
    fetcher.fetch.mockImplementation(() => {
      order.push('fetch');
      return Promise.resolve({ kind: 'NOT_MODIFIED' });
    });
    const row = source();

    await service.claimAndCheck(row);

    expect(order).toEqual(['write', 'fetch', 'write']);
    const claim = (db.apiSpecSource.updateMany.mock.calls[0] as [{ where: unknown; data: { nextCheckAt: Date; lastCheckedAt: Date } }])[0];
    expect(claim.where).toEqual({ id: 'src-1', enabled: true, nextCheckAt: row.nextCheckAt });
    expect(claim.data.lastCheckedAt).toEqual(DB_NOW);
    const ahead = claim.data.nextCheckAt.getTime() - DB_NOW.getTime();
    expect(ahead).toBeGreaterThanOrEqual(60 * 60_000);
    expect(ahead).toBeLessThanOrEqual(65 * 60_000);
  });

  it('a lost claim (another replica took it) fetches nothing', async () => {
    const { service, fetcher } = setup();
    db.apiSpecSource.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.claimAndCheck(source())).resolves.toBeNull();
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it('review LOW 5: a failure that is not a fetch refusal is recorded as ERROR CHECK_FAILED with backoff, logged by name only', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const { service, fetcher, candidates } = setup();
    fetcher.fetch.mockResolvedValue({ kind: 'OK', text: 'doc', etag: '"x"', lastModified: null });
    candidates.detect.mockRejectedValue(new Error(`boom ${SECRET_URL}`));

    await expect(service.claimAndCheck(source({ consecutiveFailures: 1 }))).resolves.toEqual({ result: 'ERROR', errorCode: 'CHECK_FAILED' });

    const data = resultWrite();
    expect(data).toMatchObject({ lastResult: 'ERROR', lastErrorCode: 'CHECK_FAILED', consecutiveFailures: 2 });
    expect(data).not.toHaveProperty('etag');
    expect(data.nextCheckAt).toEqual(new Date(DB_NOW.getTime() + 120 * 60_000));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('specs.example.com');
    warn.mockRestore();
  });

  it('review LOW 2: lastSuccessAt comes from the database clock', async () => {
    const { service, fetcher } = setup();
    fetcher.fetch.mockResolvedValue({ kind: 'NOT_MODIFIED' });
    db.$queryRaw.mockResolvedValueOnce([{ now: DB_NOW }]).mockResolvedValueOnce([{ now: new Date('2026-09-25T12:00:07.000Z') }]);

    await service.claimAndCheck(source());

    expect(resultWrite().lastSuccessAt).toEqual(new Date('2026-09-25T12:00:07.000Z'));
  });

  it('review M1: "check now" whose URL was edited mid-check answers 409 SPEC_SOURCE_CHANGED (not 404)', async () => {
    const { service, fetcher } = setup('SOURCE_CHANGED');
    db.apiSpecSource.findFirst.mockResolvedValue(source());
    fetcher.fetch.mockResolvedValue({ kind: 'OK', text: 'doc', etag: null, lastModified: null });

    expect(await statusAndCode(service.checkNow(TENANT, API))).toBe('409 SPEC_SOURCE_CHANGED');
    expect(db.apiSpecSource.updateMany).toHaveBeenCalledTimes(1); // the claim only
  });

  it('review M1: the URL-guarded write finding 0 rows while the source still exists is SOURCE_CHANGED → 409', async () => {
    const { service, fetcher } = setup({ result: 'UNCHANGED' });
    db.apiSpecSource.findFirst.mockResolvedValue(source());
    fetcher.fetch.mockResolvedValue({ kind: 'NOT_MODIFIED' });
    db.apiSpecSource.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    db.apiSpecSource.count.mockResolvedValue(1);

    expect(await statusAndCode(service.checkNow(TENANT, API))).toBe('409 SPEC_SOURCE_CHANGED');
  });

  it('source or API gone mid-check (detect → GONE) is dropped without a write', async () => {
    const { service, fetcher } = setup('GONE');
    fetcher.fetch.mockResolvedValue({ kind: 'OK', text: 'doc', etag: null, lastModified: null });

    await expect(service.claimAndCheck(source())).resolves.toBeNull();
    expect(db.apiSpecSource.updateMany).toHaveBeenCalledTimes(1);
  });

  it('the result write is guarded on the URL: an edit during the check does not inherit its answer', async () => {
    const { service, fetcher } = setup();
    fetcher.fetch.mockResolvedValue({ kind: 'NOT_MODIFIED' });
    db.apiSpecSource.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    db.apiSpecSource.count.mockResolvedValue(1);

    await expect(service.claimAndCheck(source())).resolves.toBeNull();
    expect((db.apiSpecSource.updateMany.mock.calls[1] as [{ where: unknown }])[0].where).toEqual({ id: 'src-1', tenantId: TENANT, url: SECRET_URL });
  });

  it('never logs the URL (nor its secret)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const { service, fetcher } = setup();
    fetcher.fetch.mockRejectedValue(new SpecFetchError('BLOCKED_TARGET'));

    await service.claimAndCheck(source());

    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('specs.example.com');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('s3cr3t');
    warn.mockRestore();
  });
});

describe('SpecSourceService.checkNow — cooldown on the database clock', () => {
  it('claims only when last_checked_at is older than 30 s by the DB clock', async () => {
    const { service, fetcher } = setup();
    db.apiSpecSource.findFirst.mockResolvedValue(source());
    fetcher.fetch.mockResolvedValue({ kind: 'NOT_MODIFIED' });

    await service.checkNow(TENANT, API);

    expect(db.apiSpecSource.findFirst).toHaveBeenCalledWith({ where: { apiDefId: API, tenantId: TENANT } });
    const claim = (db.apiSpecSource.updateMany.mock.calls[0] as [{ where: { OR: unknown } }])[0];
    expect(claim.where).toEqual({
      id: 'src-1',
      tenantId: TENANT,
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: new Date(DB_NOW.getTime() - 30_000) } }],
    });
  });

  it('0 rows claimed → 429 SPEC_CHECK_COOLDOWN, nothing fetched', async () => {
    const { service, fetcher } = setup();
    db.apiSpecSource.findFirst.mockResolvedValue(source());
    db.apiSpecSource.updateMany.mockResolvedValueOnce({ count: 0 });

    expect(await statusAndCode(service.checkNow(TENANT, API))).toBe('429 SPEC_CHECK_COOLDOWN');
    expect(fetcher.fetch).not.toHaveBeenCalled();
  });

  it('no source in this tenant → 404', async () => {
    const { service } = setup();
    db.apiSpecSource.findFirst.mockResolvedValue(null);

    expect(await statusAndCode(service.checkNow(TENANT, API))).toBe('404 Not Found');
  });
});

describe('SpecSourceService.put', () => {
  it('create: validates the URL first, then count-then-insert under the 50-per-tenant cap', async () => {
    const { service, fetcher } = setup();
    db.apiSpecSource.findFirst.mockResolvedValue(null);
    db.apiSpecSource.count.mockResolvedValue(MAX_SOURCES_PER_TENANT - 1);
    db.apiSpecSource.create.mockResolvedValue(source());

    await expect(service.put(TENANT, API, { url: SECRET_URL, intervalMinutes: 60 })).resolves.toMatchObject({
      configured: true,
      url: 'https://specs.example.com/…',
    });
    expect(fetcher.validateUrl).toHaveBeenCalledWith(SECRET_URL);
    expect(db.apiSpecSource.count).toHaveBeenCalledWith({ where: { tenantId: TENANT } });
    expect((db.apiSpecSource.create.mock.calls[0] as [{ data: unknown }])[0].data).toMatchObject({ tenantId: TENANT, apiDefId: API, enabled: true, nextCheckAt: DB_NOW });
  });

  it('the 51st source of a tenant is 400 SPEC_SOURCE_LIMIT', async () => {
    const { service } = setup();
    db.apiSpecSource.findFirst.mockResolvedValue(null);
    db.apiSpecSource.count.mockResolvedValue(MAX_SOURCES_PER_TENANT);

    expect(await statusAndCode(service.put(TENANT, API, { url: SECRET_URL, intervalMinutes: 60 }))).toBe('400 SPEC_SOURCE_LIMIT');
    expect(db.apiSpecSource.create).not.toHaveBeenCalled();
  });

  it('create without a url is 400 SPEC_SOURCE_URL_REQUIRED', async () => {
    const { service } = setup();
    db.apiSpecSource.findFirst.mockResolvedValue(null);

    expect(await statusAndCode(service.put(TENANT, API, { intervalMinutes: 60 }))).toBe('400 SPEC_SOURCE_URL_REQUIRED');
  });

  it('edit without a url keeps the stored one and what was learnt about it', async () => {
    const { service, fetcher } = setup();
    db.apiSpecSource.findFirst.mockResolvedValue(source());
    db.apiSpecSource.update.mockResolvedValue(source({ intervalMinutes: 15 }));

    await service.put(TENANT, API, { intervalMinutes: 15, enabled: false });

    expect(fetcher.validateUrl).not.toHaveBeenCalled();
    const { data } = (db.apiSpecSource.update.mock.calls[0] as [{ data: Record<string, unknown> }])[0];
    expect(data).toEqual({ intervalMinutes: 15, enabled: false });
  });

  it('review LOW 3: a no-op PUT does not make the source due (no cooldown bypass); re-enabling does', async () => {
    const { service } = setup();
    db.apiSpecSource.findFirst.mockResolvedValueOnce(source()).mockResolvedValueOnce(source({ enabled: false }));
    db.apiSpecSource.update.mockResolvedValue(source());

    await service.put(TENANT, API, { url: SECRET_URL, intervalMinutes: 60, enabled: true });
    await service.put(TENANT, API, { intervalMinutes: 60, enabled: true });

    const [noop, reEnable] = (db.apiSpecSource.update.mock.calls as [{ data: Record<string, unknown> }][]).map(([a]) => a.data);
    expect(noop).not.toHaveProperty('nextCheckAt');
    expect(reEnable).toMatchObject({ enabled: true, nextCheckAt: DB_NOW });
  });

  it.each([
    [' https://specs.example.com/openapi.json?token=s3cr3t'],
    ['\thttps://specs.example.com/openapi.json?token=s3cr3t'],
    ['https:specs.example.com/openapi.json?token=s3cr3t'],
    ['https:\\\\specs.example.com\\openapi.json?token=s3cr3t'],
    ['HTTPS://SPECS.example.com/openapi.json?token=s3cr3t'],
  ])('review H1: %j is stored in the form the fetcher reads, and is the SAME url as the stored one (no reset)', async (spelling) => {
    const { service, fetcher } = setup();
    db.apiSpecSource.findFirst.mockResolvedValue(source());
    db.apiSpecSource.update.mockResolvedValue(source());

    await service.put(TENANT, API, { url: spelling, intervalMinutes: 60 });

    expect(fetcher.validateUrl).toHaveBeenCalledWith(SECRET_URL);
    expect((db.apiSpecSource.update.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data).not.toHaveProperty('url');
  });

  it('review H1: a new source stores the normalised URL', async () => {
    const { service } = setup();
    db.apiSpecSource.findFirst.mockResolvedValue(null);
    db.apiSpecSource.count.mockResolvedValue(0);
    db.apiSpecSource.create.mockResolvedValue(source());

    await service.put(TENANT, API, { url: ' https:specs.example.com/openapi.json?token=s3cr3t', intervalMinutes: 60 });

    expect((db.apiSpecSource.create.mock.calls[0] as [{ data: { url: string } }])[0].data.url).toBe(SECRET_URL);
  });

  it('a URL the fetcher cannot parse is 422 SPEC_FETCH_BAD_URL before any other work', async () => {
    const { service, fetcher } = setup();

    expect(await statusAndCode(service.put(TENANT, API, { url: 'not a url', intervalMinutes: 60 }))).toBe('422 SPEC_FETCH_BAD_URL');
    expect(fetcher.validateUrl).not.toHaveBeenCalled();
  });

  it('a changed url resets etag, last_modified, last_result, error code and failures', async () => {
    const { service } = setup();
    db.apiSpecSource.findFirst.mockResolvedValue(source({ consecutiveFailures: 4 }));
    db.apiSpecSource.update.mockResolvedValue(source());

    await service.put(TENANT, API, { url: 'https://other.example.com/spec.yaml', intervalMinutes: 60 });

    const { data } = (db.apiSpecSource.update.mock.calls[0] as [{ data: Record<string, unknown> }])[0];
    expect(data).toMatchObject({
      url: 'https://other.example.com/spec.yaml',
      etag: null,
      lastModified: null,
      lastResult: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
    });
  });

  it('the same url sent again is not a change', async () => {
    const { service } = setup();
    db.apiSpecSource.findFirst.mockResolvedValue(source());
    db.apiSpecSource.update.mockResolvedValue(source());

    await service.put(TENANT, API, { url: SECRET_URL, intervalMinutes: 60 });

    expect((db.apiSpecSource.update.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data).not.toHaveProperty('etag');
  });

  it('a refused URL is 422 SPEC_FETCH_<CODE> with the fetcher’s fixed message, and nothing is written', async () => {
    const { service, fetcher } = setup();
    fetcher.validateUrl.mockRejectedValue(new SpecFetchError('BLOCKED_TARGET'));

    const error = (await service.put(TENANT, API, { url: SECRET_URL, intervalMinutes: 60 }).catch((e: unknown) => e)) as HttpException;

    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toEqual({ message: 'The spec URL is not reachable from here or not allowed.', error: 'SPEC_FETCH_BLOCKED_TARGET' });
    expect(JSON.stringify(error.getResponse())).not.toContain('specs.example.com');
    expect(db.apiSpecSource.create).not.toHaveBeenCalled();
  });

  it('another tenant’s API is 404 before anything is validated', async () => {
    const { service, fetcher } = setup();
    db.apiDefinition.findFirst.mockResolvedValue(null);

    expect(await statusAndCode(service.put('tenant-b', API, { url: SECRET_URL, intervalMinutes: 60 }))).toBe('404 Not Found');
    expect(db.apiDefinition.findFirst).toHaveBeenCalledWith({ where: { id: API, tenantId: 'tenant-b' }, select: { id: true } });
    expect(fetcher.validateUrl).not.toHaveBeenCalled();
  });
});

describe('SpecSourceService.get / remove / fetchDocument', () => {
  it('GET returns the URL redacted', async () => {
    const { service } = setup();
    db.apiSpecSource.findFirst.mockResolvedValue(source());

    const view = await service.get(TENANT, API);
    expect(view).toMatchObject({ configured: true, url: 'https://specs.example.com/…' });
    expect(JSON.stringify(view)).not.toContain('s3cr3t');
  });

  it('GET without a source is { configured: false }', async () => {
    const { service } = setup();
    db.apiSpecSource.findFirst.mockResolvedValue(null);

    await expect(service.get(TENANT, API)).resolves.toEqual({ configured: false });
  });

  it('remove supersedes the pending proposal in the same transaction; absent → 404', async () => {
    const { service, candidates } = setup();
    db.apiSpecSource.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await expect(service.remove(TENANT, API)).resolves.toEqual({ removed: true });
    expect(candidates.supersedePending).toHaveBeenCalledWith(TENANT, API, expect.anything());
    expect(await statusAndCode(service.remove(TENANT, API))).toBe('404 Not Found');
  });

  it('a 304 to an unconditional import fetch is refused like any other remote status', async () => {
    const { service, fetcher } = setup();
    fetcher.fetch.mockResolvedValue({ kind: 'NOT_MODIFIED' });

    expect(await statusAndCode(service.fetchDocument(SECRET_URL))).toBe('422 SPEC_FETCH_HTTP_304');
  });
});

describe('pure helpers', () => {
  it.each([
    [60, 1, 60],
    [60, 2, 120],
    [60, 3, 240],
    [60, 6, 1440],
    [15, 20, 1440],
    [1440, 2, 1440],
  ])('backoff(%i min, %i failures) = %i min', (interval, failures, expected) => {
    expect(backoffMinutes(interval, failures)).toBe(expected);
  });

  it('maps a SpecFetchError to 422 SPEC_FETCH_<CODE> and passes anything else through', () => {
    const mapped = specFetchHttpError(new SpecFetchError('HTTP_503')) as HttpException;
    expect(mapped.getStatus()).toBe(422);
    expect((mapped.getResponse() as { error: string }).error).toBe('SPEC_FETCH_HTTP_503');
    const other = new Error('x');
    expect(specFetchHttpError(other)).toBe(other);
  });
});
