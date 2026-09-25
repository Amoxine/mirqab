import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { type Prisma, prisma } from '@open-gateway/database';
import * as Parsers from '@stoplight/spectral-parsers';
import { pendingSpecCandidates, type ApiService } from '../../api-management/services/api.service';
import { AuditService } from '../../audit/services/audit.service';
import type { SpecFetchConditions, SpecFetcherPort, SpecFetchNotModified, SpecFetchOk } from '../../spec-fetch/spec-fetch.types';
import { ApiImportService } from './api-import.service';
import { ApiSpecService } from './api-spec.service';
import { buildEndpointIndex, contentHashOf } from './oas-endpoints';
import { SpecCandidateService } from './spec-candidate.service';
import { SpecSourceService } from './spec-source.service';
import { SpectralLintService } from './spectral-lint.service';
import { SpecUpdateService } from './spec-update.service';

/**
 * OAS-08 against a REAL Postgres: the claim compare-and-set, at-most-one PENDING, A→B→A, apply after a
 * manual upload, the APPLIED mark inside the OAS-04 transaction, retention, the cooldown and cap on the
 * database, tenant isolation on both tables. The fetcher is a fake port (no network). Not part of
 * `jest` (the name does not match `.spec.ts`): it needs a THROWAWAY database — never the stack's.
 *
 *   docker run -d --rm --name og-probe-oas08-pg -e POSTGRES_USER=t -e POSTGRES_PASSWORD=t \
 *     -e POSTGRES_DB=t -p 127.0.0.1:55448:5432 postgres:16-alpine
 *   export OG_THROWAWAY_DATABASE_URL='postgresql://t:t@127.0.0.1:55448/t?schema=public'
 *   (cd packages/database && DATABASE_URL=$OG_THROWAWAY_DATABASE_URL npx prisma migrate deploy)
 *   (cd apps/api && DATABASE_URL=$OG_THROWAWAY_DATABASE_URL npx jest --runInBand --testRegex 'spec-source\.db-spec\.ts$')
 *   docker rm -f og-probe-oas08-pg
 */

const doc = (ops: string[], title = 'Orders'): string =>
  JSON.stringify({
    openapi: '3.0.3',
    info: { title, version: '1.0.0' },
    servers: [{ url: 'https://backend.example.com' }],
    paths: Object.fromEntries(ops.map((id) => [`/${id}`, { get: { operationId: id, responses: { 200: { description: 'ok' } } } }])),
  });

const A = doc(['listOrders', 'createOrder']);
const B = doc(['listOrders', 'getOrder']);
const C = doc(['listOrders', 'cancelOrder']);
const URL_1 = 'https://specs.example.com/openapi.json?token=s3cr3t';

type Answer = SpecFetchOk | SpecFetchNotModified;

/** The fake port: answers what the test says the URL serves; counts calls. Slow on demand. */
class FakeFetcher implements SpecFetcherPort {
  serves: Answer = { kind: 'OK', text: A, etag: '"a"', lastModified: null };
  delayMs = 0;
  calls: SpecFetchConditions[] = [];
  async fetch(_url: string, cond?: SpecFetchConditions): Promise<Answer> {
    this.calls.push(cond ?? {});
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.serves;
  }
  async validateUrl(): Promise<void> {
    /* every URL allowed: the policy is the fetcher's own suite */
  }
}

const ok = (text: string, etag: string | null = null): SpecFetchOk => ({ kind: 'OK', text, etag, lastModified: null });

describe('OAS-08 spec sources and candidates on a real Postgres', () => {
  const syncNow = jest.fn().mockResolvedValue({});
  const specUpdate = new SpecUpdateService(
    new ApiImportService(new SpectralLintService(), {} as ApiService, new ApiSpecService()),
    { syncNow } as unknown as ApiService,
  );
  const candidates = new SpecCandidateService(specUpdate, new AuditService());
  const tenants: string[] = [];

  beforeAll(() => {
    Logger.overrideLogger(false);
    const url = process.env.DATABASE_URL;
    if (!url || url !== process.env.OG_THROWAWAY_DATABASE_URL || url.includes(':33002')) {
      throw new Error('Refusing to run: DATABASE_URL must equal OG_THROWAWAY_DATABASE_URL and must not be the stack database');
    }
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } }); // cascades to APIs, specs, sources, candidates
    await prisma.$disconnect();
  });

  /** A tenant with one API whose spec v1 is `A`, watched at URL_1 (due now). */
  async function seed(opts: { source?: boolean } = {}): Promise<{ tenantId: string; apiId: string; fetcher: FakeFetcher; sources: SpecSourceService }> {
    const tenantId = randomUUID();
    tenants.push(tenantId);
    await prisma.tenant.create({ data: { id: tenantId, name: 't', slug: `t-${tenantId}`, tykOrgId: `og-${tenantId}` } });
    const api = await prisma.apiDefinition.create({
      data: { tenantId, name: 'Orders', slug: 'orders', proxyUrl: 'https://backend.example.com', listenPath: '/orders/', config: {}, syncStatus: 'SYNCED' },
    });
    await prisma.apiSpec.create({
      data: {
        tenantId,
        apiDefId: api.id,
        versionNo: 1,
        contentHash: contentHashOf(A),
        format: 'json',
        openapiVersion: '3.0.3',
        sourceText: A,
        endpointIndex: buildEndpointIndex(Parsers.parseYaml(A).data).endpoints as unknown as Prisma.InputJsonValue,
        endpointCount: 2,
      },
    });
    const fetcher = new FakeFetcher();
    const sources = new SpecSourceService(fetcher, candidates);
    if (opts.source !== false) await sources.put(tenantId, api.id, { url: URL_1, intervalMinutes: 60 });
    return { tenantId, apiId: api.id, fetcher, sources };
  }

  const sourceRow = (apiDefId: string) => prisma.apiSpecSource.findUniqueOrThrow({ where: { apiDefId } });
  const rows = (apiDefId: string) =>
    prisma.specCandidate.findMany({ where: { apiDefId }, orderBy: { detectedAt: 'asc' }, select: { id: true, contentHash: true, state: true, sourceText: true } });
  const pendingCount = async (apiDefId: string): Promise<number> => prisma.specCandidate.count({ where: { apiDefId, state: 'PENDING' } });
  const versions = async (apiDefId: string): Promise<number[]> =>
    (await prisma.apiSpec.findMany({ where: { apiDefId }, select: { versionNo: true }, orderBy: { versionNo: 'asc' } })).map((r) => r.versionNo);
  const outcome = (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => 'ok',
      (e: unknown) => {
        const body = typeof (e as { getResponse?: unknown }).getResponse === 'function' ? (e as { getResponse: () => { error?: string } }).getResponse() : {};
        return `${String((e as { getStatus?: () => number }).getStatus?.() ?? 500)} ${body.error ?? String(e)}`;
      },
    );
  /** Makes the source due again without waiting (next_check_at in the past, cooldown elapsed). */
  const makeDue = (apiDefId: string) =>
    prisma.apiSpecSource.update({ where: { apiDefId }, data: { nextCheckAt: new Date(Date.now() - 60_000), lastCheckedAt: new Date(Date.now() - 120_000) } });

  it('the claim: two schedulers (replicas) on the same due row — exactly one fetches', async () => {
    const { apiId, fetcher, sources } = await seed();
    fetcher.serves = ok(B, '"b"');
    fetcher.delayMs = 200;
    const row = await sourceRow(apiId);

    const results = await Promise.all([sources.claimAndCheck(row), sources.claimAndCheck(row)]);

    expect(fetcher.calls).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.find((r) => r !== null)).toMatchObject({ result: 'CHANGED' });
    const after = await sourceRow(apiId);
    expect(after.nextCheckAt.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(after.etag).toBe('"b"');
  });

  it('"check now" and a scheduled check at once: one fetch, one PENDING, the loser is 429 or skipped', async () => {
    const { tenantId, apiId, fetcher, sources } = await seed();
    fetcher.serves = ok(B);
    fetcher.delayMs = 200;
    const row = await sourceRow(apiId);

    const [manual, scheduled] = await Promise.all([outcome(sources.checkNow(tenantId, apiId)), sources.claimAndCheck(row)]);

    expect(fetcher.calls).toHaveLength(1);
    expect([manual === 'ok', scheduled !== null].filter(Boolean)).toHaveLength(1);
    if (manual !== 'ok') expect(manual).toBe('429 SPEC_CHECK_COOLDOWN');
    expect(await pendingCount(apiId)).toBe(1);
  });

  it('two detections of DIFFERENT content at once still leave at most one PENDING (row lock)', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { tenantId, apiId } = await seed();
      const results = await Promise.all([candidates.detect(tenantId, apiId, B, URL_1), candidates.detect(tenantId, apiId, C, URL_1)]);
      expect(results.every((r) => typeof r !== 'string' && r.result === 'CHANGED')).toBe(true);
      expect(await pendingCount(apiId)).toBe(1);
      expect(await prisma.specCandidate.count({ where: { apiDefId: apiId, state: 'SUPERSEDED', sourceText: null } })).toBe(1);
    }
  });

  it('the cooldown is judged on the DB clock: a second "check now" within 30 s is 429', async () => {
    const { tenantId, apiId, fetcher, sources } = await seed();
    fetcher.serves = { kind: 'NOT_MODIFIED' };

    expect(await outcome(sources.checkNow(tenantId, apiId))).toBe('ok');
    expect(await outcome(sources.checkNow(tenantId, apiId))).toBe('429 SPEC_CHECK_COOLDOWN');
    expect(fetcher.calls).toHaveLength(1);
  });

  it('detection matrix end to end: new → PENDING + audit row; 304 → UNCHANGED; NOT_A_SPEC keeps the old etag; reverted → pending superseded', async () => {
    const { tenantId, apiId, fetcher, sources } = await seed();

    fetcher.serves = ok(B, '"b"');
    const changed = await sources.checkNow(tenantId, apiId);
    expect(changed).toMatchObject({ result: 'CHANGED', candidate: { state: 'PENDING', baseVersionNo: 1, diff: { added: 1, removed: 1 } } });
    const audit = await prisma.auditLog.findMany({ where: { tenantId, action: 'SPEC_UPDATE_DETECTED' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: null, corrId: null, resource: 'apis' });

    await makeDue(apiId);
    fetcher.serves = { kind: 'NOT_MODIFIED' };
    // Review LOW 6: nothing new, but B still waits — CHANGED, with it.
    expect(await sources.checkNow(tenantId, apiId)).toMatchObject({ result: 'CHANGED', candidate: { id: changed.candidate?.id } });
    expect(fetcher.calls.at(-1)).toEqual({ etag: '"b"', lastModified: null });
    expect((await sourceRow(apiId)).lastResult).toBe('CHANGED');

    await makeDue(apiId);
    fetcher.serves = ok('not: [a spec', '"garbage"');
    expect(await sources.checkNow(tenantId, apiId)).toEqual({ result: 'ERROR', errorCode: 'NOT_A_SPEC' });
    expect(await sourceRow(apiId)).toMatchObject({ etag: '"b"', lastResult: 'ERROR', lastErrorCode: 'NOT_A_SPEC', consecutiveFailures: 1 });

    await makeDue(apiId);
    fetcher.serves = ok(A, '"a"');
    expect(await sources.checkNow(tenantId, apiId)).toEqual({ result: 'UNCHANGED' });
    expect(await pendingCount(apiId)).toBe(0);
    expect((await rows(apiId)).map((r) => [r.state, r.sourceText])).toEqual([['SUPERSEDED', null]]);
    expect(await sourceRow(apiId)).toMatchObject({ etag: '"a"', consecutiveFailures: 0, lastErrorCode: null });
  });

  it('A→B→A: B applied, then the URL serves A again → A is proposed again (reset of its old row); dismissed content stays silent', async () => {
    const { tenantId, apiId, fetcher, sources } = await seed();
    fetcher.serves = ok(B);
    const first = await sources.checkNow(tenantId, apiId);
    await candidates.apply(tenantId, apiId, first.candidate?.id ?? '', { expectedVersion: 1, acknowledgeRemoved: false });
    expect(await versions(apiId)).toEqual([1, 2]);

    // 304 right after an apply: nothing new.
    await makeDue(apiId);
    fetcher.serves = { kind: 'NOT_MODIFIED' };
    expect(await sources.checkNow(tenantId, apiId)).toEqual({ result: 'UNCHANGED' });

    await makeDue(apiId);
    fetcher.serves = ok(C);
    const c = await sources.checkNow(tenantId, apiId);
    expect(c.result).toBe('CHANGED');
    await candidates.dismiss(tenantId, apiId, c.candidate?.id ?? '');

    await makeDue(apiId);
    expect(await sources.checkNow(tenantId, apiId)).toEqual({ result: 'UNCHANGED' }); // C dismissed: silent
    expect(await pendingCount(apiId)).toBe(0);

    await makeDue(apiId);
    fetcher.serves = ok(A);
    const again = await sources.checkNow(tenantId, apiId);
    expect(again).toMatchObject({ result: 'CHANGED', candidate: { contentHash: contentHashOf(A), baseVersionNo: 2, state: 'PENDING' } });
    const all = await rows(apiId);
    expect(all.filter((r) => r.contentHash === contentHashOf(A))).toHaveLength(1);
    expect(all.map((r) => r.state).sort()).toEqual(['APPLIED', 'DISMISSED', 'PENDING']);

    // The URL serves B again, which IS the applied v2: UNCHANGED, and A's proposal is superseded.
    await makeDue(apiId);
    fetcher.serves = ok(B);
    expect(await sources.checkNow(tenantId, apiId)).toEqual({ result: 'UNCHANGED' });
    expect(await pendingCount(apiId)).toBe(0);

    // Apply C by hand (v3), then the URL serves B again: B's APPLIED row becomes PENDING again.
    await specUpdate.update(C, tenantId, apiId, { dryRun: false, expectedVersion: 2, acknowledgeRemoved: false });
    await makeDue(apiId);
    const back = await sources.checkNow(tenantId, apiId);
    expect(back).toMatchObject({ result: 'CHANGED', candidate: { id: first.candidate?.id, contentHash: contentHashOf(B), baseVersionNo: 3 } });
    expect((await prisma.specCandidate.findUniqueOrThrow({ where: { id: first.candidate?.id } })).sourceText).toBe(B);
  });

  it('apply after a manual upload: 409 SPEC_VERSION_STALE, re-diff gives the new versionNo, apply with it succeeds and marks APPLIED', async () => {
    const { tenantId, apiId, fetcher, sources } = await seed();
    fetcher.serves = ok(B);
    const { candidate } = await sources.checkNow(tenantId, apiId);
    const cid = candidate?.id ?? '';

    await specUpdate.update(C, tenantId, apiId, { dryRun: false, expectedVersion: 1, acknowledgeRemoved: false }); // v2 by hand

    expect(await outcome(candidates.apply(tenantId, apiId, cid, { expectedVersion: 1, acknowledgeRemoved: false }))).toBe('409 SPEC_VERSION_STALE');
    expect((await prisma.specCandidate.findUniqueOrThrow({ where: { id: cid } })).state).toBe('PENDING');

    const diff = await candidates.diff(tenantId, apiId, cid);
    expect(diff).toMatchObject({ dryRun: true, versionNo: 2 });
    expect(diff.diff.added.map((e) => e.key)).toEqual(['getOrder']);
    expect(diff.diff.removed.map((e) => e.key)).toEqual(['cancelOrder']);

    await expect(candidates.apply(tenantId, apiId, cid, { expectedVersion: diff.versionNo, acknowledgeRemoved: false, userId: 'user-1' })).resolves.toMatchObject({
      applied: true,
      versionNo: 3,
    });
    expect(await prisma.specCandidate.findUniqueOrThrow({ where: { id: cid } })).toMatchObject({ state: 'APPLIED', sourceText: null, decidedBy: 'user-1' });
  });

  it('an apply the OAS-04 rules refuse leaves the candidate PENDING; a candidate decided meanwhile rolls the new version back', async () => {
    const { tenantId, apiId, fetcher, sources } = await seed();
    await prisma.apiDefinition.update({ where: { id: apiId }, data: { config: { endpoints: { createOrder: { enabled: false } } } } });
    fetcher.serves = ok(B); // removes the governed createOrder
    const { candidate } = await sources.checkNow(tenantId, apiId);
    const cid = candidate?.id ?? '';

    expect(await outcome(candidates.apply(tenantId, apiId, cid, { expectedVersion: 1, acknowledgeRemoved: false }))).toBe('409 SPEC_REMOVES_GOVERNED_ENDPOINTS');
    expect((await prisma.specCandidate.findUniqueOrThrow({ where: { id: cid } })).state).toBe('PENDING');
    expect(await versions(apiId)).toEqual([1]);

    // Dismissed by someone else between the read of the text and the transaction: the hook refuses.
    const original = prisma.$transaction.bind(prisma);
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      prisma.specCandidate.update({ where: { id: cid }, data: { state: 'DISMISSED' } }).then(() => original(fn))) as unknown as typeof prisma.$transaction);
    try {
      expect(await outcome(candidates.apply(tenantId, apiId, cid, { expectedVersion: 1, acknowledgeRemoved: true }))).toBe('409 CANDIDATE_STALE');
    } finally {
      spy.mockRestore();
    }
    expect(await versions(apiId)).toEqual([1]);
    expect((await prisma.apiDefinition.findUniqueOrThrow({ where: { id: apiId } })).syncStatus).toBe('SYNCED');
  });

  it('pending is derived: a manual upload of the SAME bytes makes the banner vanish without touching the row', async () => {
    const { tenantId, apiId, fetcher, sources } = await seed();
    fetcher.serves = ok(B);
    await sources.checkNow(tenantId, apiId);
    expect(await pendingSpecCandidates(tenantId, [apiId])).toHaveLength(1);

    await specUpdate.update(B, tenantId, apiId, { dryRun: false, expectedVersion: 1, acknowledgeRemoved: false });

    expect(await pendingCount(apiId)).toBe(1);
    expect(await pendingSpecCandidates(tenantId, [apiId])).toEqual([]);
    expect(await candidates.list(tenantId, apiId)).toMatchObject({ pending: null });
    expect((await candidates.pendingUpdates(tenantId)).items).toEqual([]);
  });

  it('retention: 20 rows per API; only PENDING keeps its text', async () => {
    const { tenantId, apiId } = await seed();
    for (let i = 0; i < 23; i += 1) {
      await candidates.detect(tenantId, apiId, doc(['listOrders', `op${String(i)}`]), URL_1);
    }
    const all = await rows(apiId);
    expect(all).toHaveLength(20);
    expect(all.filter((r) => r.state === 'PENDING')).toHaveLength(1);
    expect(all.filter((r) => r.sourceText !== null).map((r) => r.state)).toEqual(['PENDING']);
    expect(all.at(-1)?.contentHash).toBe(contentHashOf(doc(['listOrders', 'op22'])));
  }, 60_000);

  it('removing the source supersedes the pending proposal', async () => {
    const { tenantId, apiId, fetcher, sources } = await seed();
    fetcher.serves = ok(B);
    await sources.checkNow(tenantId, apiId);

    await sources.remove(tenantId, apiId);

    expect(await prisma.apiSpecSource.count({ where: { apiDefId: apiId } })).toBe(0);
    expect((await rows(apiId)).map((r) => [r.state, r.sourceText])).toEqual([['SUPERSEDED', null]]);
    // A detection finishing after the removal is dropped (no source row to lock).
    expect(await candidates.detect(tenantId, apiId, C, URL_1)).toBe('GONE');
    expect(await pendingCount(apiId)).toBe(0);
  });

  it('review M1: PUT url=U2 while U1 is being checked — no candidate or audit row from U1, check now answers 409', async () => {
    const { tenantId, apiId, fetcher, sources } = await seed();
    fetcher.serves = ok(B);
    fetcher.delayMs = 300;
    const U2 = 'https://other.example.com/openapi.json';

    const check = outcome(sources.checkNow(tenantId, apiId));
    await new Promise((resolve) => setTimeout(resolve, 100)); // the fetch of U1 is in flight
    await sources.put(tenantId, apiId, { url: U2, intervalMinutes: 60 });

    expect(await check).toBe('409 SPEC_SOURCE_CHANGED');
    expect(await rows(apiId)).toEqual([]);
    expect(await prisma.auditLog.count({ where: { tenantId, action: 'SPEC_UPDATE_DETECTED' } })).toBe(0);
    expect(await sourceRow(apiId)).toMatchObject({ url: U2, etag: null, lastResult: null });
  });

  it('review M1: a detection whose URL no longer matches is refused under the row lock too', async () => {
    const { tenantId, apiId } = await seed();

    expect(await candidates.detect(tenantId, apiId, B, 'https://stale.example.com/x')).toBe('SOURCE_CHANGED');
    expect(await rows(apiId)).toEqual([]);
  });

  it('review LOW 1: content applied by hand while B was pending then detected again is UNCHANGED, not a reset of its APPLIED row', async () => {
    const { tenantId, apiId } = await seed();
    await specUpdate.update(B, tenantId, apiId, { dryRun: false, expectedVersion: 1, acknowledgeRemoved: false });

    expect(await candidates.detect(tenantId, apiId, B, URL_1)).toEqual({ result: 'UNCHANGED' });
    expect(await rows(apiId)).toEqual([]);
    expect(await prisma.auditLog.count({ where: { tenantId, action: 'SPEC_UPDATE_DETECTED' } })).toBe(0);
  });

  it('review LOW 3: a no-op PUT keeps next_check_at, so "check now" stays in cooldown', async () => {
    const { tenantId, apiId, fetcher, sources } = await seed();
    fetcher.serves = { kind: 'NOT_MODIFIED' };
    expect(await outcome(sources.checkNow(tenantId, apiId))).toBe('ok');
    const before = await sourceRow(apiId);

    await sources.put(tenantId, apiId, { url: URL_1, intervalMinutes: 60 });
    // Review H1: the same URL spelt differently is not a change either.
    await sources.put(tenantId, apiId, { url: ` ${URL_1.replace('https://', 'HTTPS://')}`, intervalMinutes: 60 });

    const after = await sourceRow(apiId);
    expect(after.nextCheckAt).toEqual(before.nextCheckAt);
    expect(after.url).toBe(URL_1);
    expect(await outcome(sources.checkNow(tenantId, apiId))).toBe('429 SPEC_CHECK_COOLDOWN');
  });

  it('review LOW 2: detected_at / decided_at are written by the database clock', async () => {
    const { tenantId, apiId, fetcher, sources } = await seed();
    fetcher.serves = ok(B);
    const { candidate } = await sources.checkNow(tenantId, apiId);
    await candidates.dismiss(tenantId, apiId, candidate?.id ?? '');
    const [{ skew }] = await prisma.$queryRaw<{ skew: number }[]>`
      SELECT EXTRACT(EPOCH FROM (now() - decided_at))::float AS skew FROM spec_candidates WHERE id = ${candidate?.id ?? ''}`;
    expect(skew).toBeGreaterThanOrEqual(0);
    expect(skew).toBeLessThan(5);
  });

  it('the 50-sources cap holds per tenant', async () => {
    const { tenantId, sources } = await seed({ source: false });
    const apis = await Promise.all(
      Array.from({ length: 51 }, (_, i) =>
        prisma.apiDefinition.create({
          data: { tenantId, name: `a${String(i)}`, slug: `a${String(i)}`, proxyUrl: 'https://backend.example.com', listenPath: `/a${String(i)}/` },
          select: { id: true },
        }),
      ),
    );
    for (const api of apis.slice(0, 50)) await sources.put(tenantId, api.id, { url: URL_1, intervalMinutes: 1440 });
    expect(await outcome(sources.put(tenantId, apis[50].id, { url: URL_1, intervalMinutes: 1440 }))).toBe('400 SPEC_SOURCE_LIMIT');
    // Editing an existing one is not a new source.
    expect(await outcome(sources.put(tenantId, apis[0].id, { intervalMinutes: 15 }))).toBe('ok');
  });

  it('tenant isolation on both tables: the other tenant sees and changes nothing (404), lists nothing', async () => {
    const a = await seed();
    const b = await seed();
    a.fetcher.serves = ok(B);
    const { candidate } = await a.sources.checkNow(a.tenantId, a.apiId);
    const cid = candidate?.id ?? '';
    const before = await sourceRow(a.apiId);

    expect(await outcome(b.sources.get(b.tenantId, a.apiId))).toBe('404 Not Found');
    expect(await outcome(b.sources.put(b.tenantId, a.apiId, { url: 'https://evil.example.com/x', intervalMinutes: 15 }))).toBe('404 Not Found');
    expect(await outcome(b.sources.remove(b.tenantId, a.apiId))).toBe('404 Not Found');
    expect(await outcome(b.sources.checkNow(b.tenantId, a.apiId))).toBe('404 Not Found');
    expect(await outcome(candidates.list(b.tenantId, a.apiId))).toBe('404 Not Found');
    expect(await outcome(candidates.diff(b.tenantId, a.apiId, cid))).toBe('404 Not Found');
    expect(await outcome(candidates.apply(b.tenantId, a.apiId, cid, { expectedVersion: 1, acknowledgeRemoved: true }))).toBe('404 Not Found');
    expect(await outcome(candidates.dismiss(b.tenantId, a.apiId, cid))).toBe('404 Not Found');
    // The candidate id under B's OWN API is not found either.
    expect(await outcome(candidates.apply(b.tenantId, b.apiId, cid, { expectedVersion: 1, acknowledgeRemoved: true }))).toBe('404 Not Found');
    expect((await candidates.pendingUpdates(b.tenantId)).items).toEqual([]);
    expect(await pendingSpecCandidates(b.tenantId, [a.apiId])).toEqual([]);

    expect((await candidates.pendingUpdates(a.tenantId)).items).toEqual([expect.objectContaining({ apiId: a.apiId, candidateId: cid, apiName: 'Orders' })]);
    const after = await sourceRow(a.apiId);
    expect(after.url).toBe(before.url);
    expect(after.intervalMinutes).toBe(before.intervalMinutes);
    expect((await prisma.specCandidate.findUniqueOrThrow({ where: { id: cid } })).state).toBe('PENDING');
    expect(await versions(a.apiId)).toEqual([1]);
  });
});
