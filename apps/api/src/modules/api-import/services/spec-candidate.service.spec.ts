import { ConflictException, type HttpException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AuditService } from '../../audit/services/audit.service';
import { contentHashOf } from './oas-endpoints';
import { SpecCandidateService } from './spec-candidate.service';
import type { SpecUpdateOptions, SpecUpdateResult, SpecUpdateService } from './spec-update.service';

jest.mock('@open-gateway/database', () => {
  const prisma = {
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    apiDefinition: { findFirst: jest.fn() },
    apiSpec: { findFirst: jest.fn() },
    apiSpecSource: { findFirst: jest.fn() },
    specCandidate: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
  return { prisma, Prisma: { sql: jest.fn(), join: jest.fn(), empty: '' } };
});

interface Db {
  $queryRaw: jest.Mock;
  apiDefinition: { findFirst: jest.Mock };
  apiSpec: { findFirst: jest.Mock };
  apiSpecSource: { findFirst: jest.Mock };
  specCandidate: Record<'findFirst' | 'findMany' | 'create' | 'update' | 'updateMany' | 'deleteMany', jest.Mock>;
}
const { prisma: db } = jest.requireMock<{ prisma: Db }>('@open-gateway/database');

/**
 * OAS-08 detection matrix and candidate transitions, with the OAS-04 service and Prisma mocked
 * (mocked evidence). The same rules against a real Postgres: `spec-source.db-spec.ts`.
 */

const TENANT = 'tenant-a';
const API = 'api-1';
const TEXT = 'openapi: 3.0.3 # new';
const URL_1 = 'https://specs.example.com/openapi.json';
const DB_NOW = new Date('2026-09-25T12:00:00.000Z');
/** Rows the `SELECT id, url … FOR UPDATE` lock returns; `SELECT now()` answers DB_NOW. */
let lockRows: { id: string; url: string }[] = [];
/** What `pendingSpecCandidates` (a Prisma.sql query, mocked away) returns. */
let pendingRows: { id: string; apiDefId: string }[] = [];
const HASH = contentHashOf(TEXT);

const dryResult = (over: Partial<SpecUpdateResult> = {}): SpecUpdateResult => ({
  dryRun: true,
  applied: false,
  unchanged: false,
  versionNo: 3,
  findings: [],
  diff: { added: [{ key: 'a' }, { key: 'b' }], removed: [{ key: 'c' }], changed: [] } as unknown as SpecUpdateResult['diff'],
  governanceImpact: { removedGoverned: [{ key: 'c', governance: {} }], changedGoverned: [] } as unknown as SpecUpdateResult['governanceImpact'],
  document: { contentHash: HASH, format: 'yaml', openapiVersion: '3.0.3', endpointCount: 7 },
  ...over,
});

function setup(dry: SpecUpdateResult | Error = dryResult()) {
  const update = jest.fn((_text: string, _t: string, _a: string, _o: SpecUpdateOptions) =>
    dry instanceof Error ? Promise.reject(dry) : Promise.resolve(dry),
  );
  const record = jest.fn().mockResolvedValue(undefined);
  const service = new SpecCandidateService({ update } as unknown as SpecUpdateService, { record } as unknown as AuditService);
  return { service, update, record };
}

const stored = { id: 'cand-1', contentHash: HASH, state: 'PENDING', detectedAt: new Date(), decidedAt: null, endpointCount: 7, baseVersionNo: 3, diffSummary: {} };

beforeEach(() => {
  jest.clearAllMocks();
  db.apiSpec.findFirst.mockResolvedValue({ versionNo: 3, contentHash: 'applied-hash' });
  db.specCandidate.findFirst.mockResolvedValue(null);
  db.specCandidate.findMany.mockResolvedValue([]);
  db.specCandidate.updateMany.mockResolvedValue({ count: 1 });
  db.specCandidate.create.mockResolvedValue(stored);
  db.specCandidate.update.mockResolvedValue(stored);
  lockRows = [{ id: 'src-1', url: URL_1 }];
  pendingRows = [];
  db.$queryRaw.mockImplementation((strings?: TemplateStringsArray) =>
    Promise.resolve(Array.isArray(strings) ? (strings.join('?').includes('now()') ? [{ now: DB_NOW }] : lockRows) : pendingRows),
  );
  db.apiSpecSource.findFirst.mockResolvedValue({ url: URL_1 });
});

const superseded = (): boolean =>
  db.specCandidate.updateMany.mock.calls.some(
    ([args]: [{ where: { state?: string }; data: { state?: string; sourceText?: unknown } }]) =>
      args.where.state === 'PENDING' && args.data.state === 'SUPERSEDED' && args.data.sourceText === null,
  );

describe('SpecCandidateService.detect — the matrix', () => {
  it('content equal to the applied version: UNCHANGED, a pending proposal is superseded (reverted URL), no lint', async () => {
    const { service, update } = setup();
    db.apiSpec.findFirst.mockResolvedValue({ versionNo: 3, contentHash: HASH });

    await expect(service.detect(TENANT, API, TEXT, URL_1)).resolves.toEqual({ result: 'UNCHANGED' });
    expect(superseded()).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it('content already pending: CHANGED with that candidate (the update is still waiting), nothing written, no lint', async () => {
    const { service, update } = setup();
    db.specCandidate.findFirst.mockResolvedValue(stored);

    await expect(service.detect(TENANT, API, TEXT, URL_1)).resolves.toMatchObject({ result: 'CHANGED', candidate: { id: 'cand-1', state: 'PENDING' } });
    expect(update).not.toHaveBeenCalled();
    expect(db.specCandidate.updateMany).not.toHaveBeenCalled();
  });

  it('dismissed content: silent (UNCHANGED), the other pending one is superseded, no lint', async () => {
    const { service, update, record } = setup();
    db.specCandidate.findFirst.mockResolvedValue({ state: 'DISMISSED' });

    await expect(service.detect(TENANT, API, TEXT, URL_1)).resolves.toEqual({ result: 'UNCHANGED' });
    expect(superseded()).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('a document the OAS-04 gates refuse (422/413) is ERROR NOT_A_SPEC and never a candidate', async () => {
    const { service } = setup(new UnprocessableEntityException({ error: 'OAS_IMPORT_UNPARSEABLE' }));

    await expect(service.detect(TENANT, API, TEXT, URL_1)).resolves.toEqual({ result: 'ERROR', errorCode: 'NOT_A_SPEC' });
    expect(db.specCandidate.create).not.toHaveBeenCalled();
  });

  it('a document with a lint ERROR is ERROR NOT_A_SPEC', async () => {
    const { service } = setup(dryResult({ findings: [{ code: 'x', message: 'm', severity: 'error', path: '', line: 1 }] }));

    await expect(service.detect(TENANT, API, TEXT, URL_1)).resolves.toEqual({ result: 'ERROR', errorCode: 'NOT_A_SPEC' });
    expect(db.specCandidate.create).not.toHaveBeenCalled();
  });

  it('the API vanished (404 from the dry run): GONE', async () => {
    const { service } = setup(new NotFoundException());

    await expect(service.detect(TENANT, API, TEXT, URL_1)).resolves.toBe('GONE');
  });

  it('review M1: the source URL was edited before detection started: SOURCE_CHANGED, nothing linted or written', async () => {
    const { service, update, record } = setup();
    db.apiSpecSource.findFirst.mockResolvedValue({ url: 'https://other.example.com/spec.json' });

    await expect(service.detect(TENANT, API, TEXT, URL_1)).resolves.toBe('SOURCE_CHANGED');
    expect(update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('review M1: the URL was edited during the lint (seen under the row lock): SOURCE_CHANGED, no candidate, no audit row', async () => {
    const { service, record } = setup();
    lockRows = [{ id: 'src-1', url: 'https://other.example.com/spec.json' }];

    await expect(service.detect(TENANT, API, TEXT, URL_1)).resolves.toBe('SOURCE_CHANGED');
    expect(db.specCandidate.create).not.toHaveBeenCalled();
    expect(db.specCandidate.update).not.toHaveBeenCalled();
    expect(db.specCandidate.updateMany).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('review LOW 1: this content was applied while it was being linted (re-read under the lock): UNCHANGED, the APPLIED row is not reset', async () => {
    const { service, record } = setup();
    db.apiSpec.findFirst
      .mockResolvedValueOnce({ versionNo: 3, contentHash: 'applied-hash' }) // before the lint
      .mockResolvedValueOnce({ contentHash: HASH }); // under the lock: the apply committed

    await expect(service.detect(TENANT, API, TEXT, URL_1)).resolves.toEqual({ result: 'UNCHANGED' });
    expect(db.specCandidate.update).not.toHaveBeenCalled();
    expect(db.specCandidate.create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('review LOW 2: supersede and reset use the DATABASE clock', async () => {
    const { service } = setup();
    db.specCandidate.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...stored, id: 'cand-old', state: 'SUPERSEDED' });

    await service.detect(TENANT, API, TEXT, URL_1);

    const supersede = (db.specCandidate.updateMany.mock.calls[0] as [{ data: { decidedAt: Date } }])[0];
    expect(supersede.data.decidedAt).toBe(DB_NOW);
    expect((db.specCandidate.update.mock.calls[0] as [{ data: { detectedAt: Date } }])[0].data.detectedAt).toBe(DB_NOW);
  });

  it('new content: dry run against the latest version, one PENDING row (old pending superseded first), one audit row without a user', async () => {
    const { service, update, record } = setup();

    const detection = await service.detect(TENANT, API, TEXT, URL_1);

    expect(update.mock.calls[0][3]).toEqual({ dryRun: true, expectedVersion: 3, acknowledgeRemoved: false });
    expect(superseded()).toBe(true);
    const created = (db.specCandidate.create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(created).toMatchObject({
      tenantId: TENANT,
      apiDefId: API,
      contentHash: HASH,
      sourceText: TEXT,
      baseVersionNo: 3,
      endpointCount: 7,
      diffSummary: { added: 2, removed: 1, changed: 0, governedRemoved: 1, governedChanged: 0 },
    });
    expect(detection).toMatchObject({ result: 'CHANGED', candidate: { id: 'cand-1' } });
    expect(record).toHaveBeenCalledTimes(1);
    const entry = (record.mock.calls[0] as [Record<string, unknown>])[0];
    expect(entry).toMatchObject({ tenantId: TENANT, action: 'SPEC_UPDATE_DETECTED', resource: 'apis' });
    expect(entry).not.toHaveProperty('userId');
    expect(entry).not.toHaveProperty('correlationId');
  });

  it('A→B→A: content seen before (SUPERSEDED/APPLIED) becomes PENDING again by resetting its row', async () => {
    const { service } = setup();
    db.specCandidate.findFirst.mockResolvedValue({ ...stored, id: 'cand-old', state: 'SUPERSEDED' });

    await expect(service.detect(TENANT, API, TEXT, URL_1)).resolves.toMatchObject({ result: 'CHANGED' });
    expect(db.specCandidate.create).not.toHaveBeenCalled();
    const updated = (db.specCandidate.update.mock.calls[0] as [{ where: unknown; data: Record<string, unknown> }])[0];
    expect(updated.where).toEqual({ id: 'cand-old' });
    expect(updated.data).toMatchObject({ state: 'PENDING', sourceText: TEXT, decidedAt: null, decidedBy: null });
  });

  it('the source was removed before the write (no row to lock): GONE, nothing stored or audited', async () => {
    const { service, record } = setup();
    lockRows = [];

    await expect(service.detect(TENANT, API, TEXT, URL_1)).resolves.toBe('GONE');
    expect(db.specCandidate.create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps the newest 20: older decided rows are deleted, never a PENDING one', async () => {
    const { service } = setup();
    db.specCandidate.findMany.mockResolvedValue([{ id: 'old-1' }, { id: 'old-2' }]);

    await service.detect(TENANT, API, TEXT, URL_1);

    expect((db.specCandidate.findMany.mock.calls[0] as [{ skip: number }])[0].skip).toBe(20);
    expect(db.specCandidate.deleteMany).toHaveBeenCalledWith({ where: { tenantId: TENANT, id: { in: ['old-1', 'old-2'] }, state: { not: 'PENDING' } } });
  });

  it('a version applied during the check (409 from the dry run) is thrown, not recorded as a result', async () => {
    const { service } = setup(new ConflictException({ error: 'SPEC_VERSION_STALE' }));

    await expect(service.detect(TENANT, API, TEXT, URL_1)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('SpecCandidateService apply / dismiss / diff', () => {
  const pendingRow = { state: 'PENDING', sourceText: TEXT };

  it('apply = OAS-04 apply with the reviewed version; the candidate is marked APPLIED inside its transaction', async () => {
    const { service, update } = setup(dryResult({ dryRun: false, applied: true, versionNo: 4 }));
    db.specCandidate.findFirst.mockResolvedValue(pendingRow);

    await service.apply(TENANT, API, 'cand-1', { expectedVersion: 3, acknowledgeRemoved: true, userId: 'user-1' });

    const options = update.mock.calls[0][3];
    expect(options).toMatchObject({ dryRun: false, expectedVersion: 3, acknowledgeRemoved: true });
    expect(db.specCandidate.updateMany).not.toHaveBeenCalled(); // not before the transaction
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ now: DB_NOW }]), specCandidate: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    await options.onApplied?.(tx as never);
    expect(tx.specCandidate.updateMany).toHaveBeenCalledWith({
      where: { id: 'cand-1', tenantId: TENANT, apiDefId: API, state: 'PENDING' },
      data: { state: 'APPLIED', decidedAt: DB_NOW, decidedBy: 'user-1', sourceText: null },
    });
  });

  it('the hook throws CANDIDATE_STALE when the candidate stopped being PENDING, which rolls the apply back', async () => {
    const { service, update } = setup(dryResult({ dryRun: false, applied: true }));
    db.specCandidate.findFirst.mockResolvedValue(pendingRow);
    await service.apply(TENANT, API, 'cand-1', { expectedVersion: 3, acknowledgeRemoved: false });

    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ now: DB_NOW }]), specCandidate: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } };
    const error = (await update.mock.calls[0][3].onApplied?.(tx as never).catch((e: unknown) => e)) as HttpException;
    expect(error.getStatus()).toBe(409);
    expect((error.getResponse() as { error: string }).error).toBe('CANDIDATE_STALE');
  });

  it.each([
    ['another tenant’s / unknown candidate', null, '404'],
    ['a dismissed candidate', { state: 'DISMISSED', sourceText: null }, '409 CANDIDATE_STALE'],
    ['a superseded candidate', { state: 'SUPERSEDED', sourceText: null }, '409 CANDIDATE_STALE'],
  ])('apply and diff refuse %s', async (_label, row, expected) => {
    const { service, update } = setup();
    db.specCandidate.findFirst.mockResolvedValue(row);
    const outcome = (p: Promise<unknown>): Promise<string> =>
      p.then(
        () => 'ok',
        (e: unknown) => {
          const http = e as HttpException;
          return `${String(http.getStatus())}${http.getStatus() === 409 ? ` ${(http.getResponse() as { error: string }).error}` : ''}`;
        },
      );

    expect(await outcome(service.apply(TENANT, API, 'cand-1', { expectedVersion: 3, acknowledgeRemoved: false }))).toBe(expected);
    expect(await outcome(service.diff(TENANT, API, 'cand-1'))).toBe(expected);
    expect(update).not.toHaveBeenCalled();
    expect(db.specCandidate.findFirst).toHaveBeenCalledWith({ where: { id: 'cand-1', tenantId: TENANT, apiDefId: API }, select: { state: true, sourceText: true } });
  });

  it('diff re-runs the OAS-04 dry run on the candidate text against the CURRENT latest version', async () => {
    const { service, update } = setup();
    db.specCandidate.findFirst.mockResolvedValue(pendingRow);
    db.apiSpec.findFirst.mockResolvedValue({ versionNo: 5 });

    await service.diff(TENANT, API, 'cand-1');

    expect(update).toHaveBeenCalledWith(TEXT, TENANT, API, { dryRun: true, expectedVersion: 5, acknowledgeRemoved: false });
  });

  it('dismiss marks it DISMISSED (text dropped); a second dismiss is 409', async () => {
    const { service } = setup();
    db.specCandidate.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    db.specCandidate.findFirst.mockResolvedValue({ state: 'DISMISSED', sourceText: null });

    await expect(service.dismiss(TENANT, API, 'cand-1', 'user-1')).resolves.toEqual({ state: 'DISMISSED' });
    expect((db.specCandidate.updateMany.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data).toMatchObject({
      state: 'DISMISSED',
      sourceText: null,
      decidedBy: 'user-1',
    });
    await expect(service.dismiss(TENANT, API, 'cand-1')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('SpecCandidateService stale PENDING rows (review LOW 6)', () => {
  it('settleStale supersedes (text dropped) only PENDING rows whose content IS the latest version', async () => {
    const { service } = setup();
    db.apiSpec.findFirst.mockResolvedValue({ contentHash: HASH });

    await service.settleStale(TENANT, API);

    expect(db.specCandidate.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, apiDefId: API, state: 'PENDING', contentHash: HASH },
      data: { state: 'SUPERSEDED', decidedAt: DB_NOW, decidedBy: null, sourceText: null },
    });
  });

  it('list settles first, and never shows a non-displayed PENDING row as PENDING in history', async () => {
    const { service } = setup();
    db.apiDefinition.findFirst.mockResolvedValue({ id: API });
    pendingRows = [];
    db.specCandidate.findMany.mockResolvedValue([{ ...stored, format: 'json', openapiVersion: '3.0.3', findings: [] }]);

    const result = await service.list(TENANT, API);

    expect(db.specCandidate.updateMany).toHaveBeenCalled();
    expect(result.pending).toBeNull();
    expect(result.history.map((h) => h.state)).toEqual(['SUPERSEDED']);
  });
});
