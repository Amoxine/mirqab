import { performance } from 'node:perf_hooks';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { searchIndexedAgeSeconds, searchSkippedRowsTotal } from '../../../common/metrics/ops-metrics';
import { projectionTag, TAG_PENDING } from './traffic-search.state';
import { TrafficSearchIndexerService } from './traffic-search.indexer.service';
import type { CapturedRow } from './traffic-search.row';
import type { TrafficSearchStoreService } from './traffic-search.store.service';

/** The yield between slices of parsing is `setImmediate` from `node:timers/promises`: counted here instead of waited for. */
const mockYields = jest.fn(() => Promise.resolve());
jest.mock('node:timers/promises', () => ({ setImmediate: () => mockYields() }));

/**
 * The indexer against a scripted Prisma: no database. What it proves is the control flow that a real database makes
 * slow and awkward to provoke (a row Postgres refuses, a state read that fails, a reset in the middle of a scan); the
 * SQL itself is proved on a real Postgres in `traffic-search.indexer.db-spec.ts`.
 */

const NOW = new Date('2026-09-29T12:00:00.000Z');
const FLOOR_MS = 30 * 86_400_000;

interface StateRow {
  scanned_until: Date;
  indexed_from: Date | null;
  generation: bigint;
  redaction_tag: string | null;
  auth_headers: Record<string, string | null>;
}

interface Script {
  state: StateRow | null | Error;
  triggerPresent: boolean;
  tablePresent: boolean;
  ddlTag: string | null;
  apis: { tykApiId: string; config: unknown }[];
  /** One entry per `tyk_analytics` page the scan reads; the last is repeated when the scan asks for more. */
  pages: CapturedRow[][];
  /** Throws for an insert whose batch holds one of these keys (`'*'` = every insert). */
  refuse: Map<string, Error>;
  /** Rows an `INSERT INTO ...state` reports as changed: 0 = a reset got in between. */
  commitChanges: number;
}

const tag = projectionTag('ddl:abc');
const stateRow = (over: Partial<StateRow> = {}): StateRow => ({
  scanned_until: new Date(NOW.getTime() - 60_000),
  indexed_from: new Date(NOW.getTime() - 7 * 86_400_000),
  generation: 3n,
  redaction_tag: tag,
  auth_headers: {},
  ...over,
});

const captured = (i: number, over: Partial<CapturedRow> = {}): CapturedRow => ({
  ts_iso: `2026-09-29T11:${String(i % 60).padStart(2, '0')}:00.000001Z`,
  apiid: 'tyk-a',
  apikey: 'hash',
  alias: 'qbus-web',
  ipaddress: '10.0.0.7',
  method: 'POST',
  path: '/orders',
  responsecode: 402n,
  latency_total: 340n,
  rawrequest: null,
  rawresponse: null,
  dedupe_key: `k${String(i)}`,
  ...over,
});

const dataError = (): Error => Object.assign(new Error('Raw query failed. Code: `22021`. Message: `invalid byte sequence for encoding "UTF8": 0x00`'), { meta: { code: '22021' } });
const connectionError = (): Error => new Error("Can't reach database server");

const textOf = (q: unknown): string => (Array.isArray(q) ? (q as string[]).join('?') : (q as { text: string }).text);

function setup(over: Partial<Script> = {}) {
  const script: Script = {
    state: stateRow(),
    triggerPresent: true,
    tablePresent: true,
    ddlTag: 'ddl:abc',
    apis: [],
    pages: [[]],
    refuse: new Map(),
    commitChanges: 1,
    ...over,
  };
  const calls = {
    queries: [] as string[],
    pageParams: [] as unknown[][],
    inserts: [] as { keys: string[]; generation: unknown }[],
    commits: [] as unknown[][],
    resets: 0,
    executed: [] as string[],
    txOptions: [] as unknown[],
  };
  let pageIndex = 0;

  const queryRaw = (first: unknown, ...values: unknown[]): Promise<unknown[]> => {
    const text = textOf(first);
    calls.queries.push(text);
    const sqlValues = Array.isArray(first) ? values : ((first as { values: unknown[] }).values);
    if (text.includes('SELECT now()')) return Promise.resolve([{ now: NOW }]);
    if (text.includes('FROM public.og_traffic_search_state')) {
      if (script.state instanceof Error) return Promise.reject(script.state);
      return Promise.resolve(script.state ? [script.state] : []);
    }
    if (text.includes('pg_trigger')) return Promise.resolve([{ present: script.triggerPresent }]);
    if (text.includes('to_regclass(\'public.og_traffic_search\') IS NOT NULL AS present')) return Promise.resolve([{ present: script.tablePresent }]);
    if (text.includes('to_regprocedure')) return Promise.resolve([{ present: script.ddlTag !== null, tag: script.ddlTag }]);
    if (text.includes('to_regclass(\'public.og_traffic_search_state\')')) return Promise.resolve([{ state: true, rows: true }]);
    if (text.includes('FROM public.tyk_analytics')) {
      calls.pageParams.push(sqlValues);
      const page = script.pages[Math.min(pageIndex, script.pages.length - 1)] ?? [];
      pageIndex += 1;
      return Promise.resolve(page);
    }
    if (text.includes('min(ts)')) return Promise.resolve([{ ts: null }]);
    return Promise.reject(new Error(`unscripted query: ${text}`));
  };

  const executeRaw = (first: unknown, ...values: unknown[]): Promise<number> => {
    const text = textOf(first);
    calls.executed.push(text);
    if (/INSERT INTO public\.og_traffic_search\s*\(/.test(text) || text.includes('INSERT INTO public.og_traffic_search\n')) {
      // `Prisma.raw(FULLTEXT_ANY)` is interpolated into the statement as an SQL fragment, not as a bound parameter.
      const params = values.filter((v) => !(typeof v === 'object' && v !== null && 'strings' in v));
      const keys = params[15] as string[];
      calls.inserts.push({ keys, generation: params[16] });
      for (const [key, error] of script.refuse) if (key === '*' || keys.includes(key)) return Promise.reject(error);
      return Promise.resolve(keys.length);
    }
    if (text.includes('generation = s.generation + 1')) {
      calls.resets += 1;
      script.state = stateRow({
        scanned_until: new Date(NOW.getTime() - FLOOR_MS),
        indexed_from: null,
        generation: 4n,
        redaction_tag: values[1] as string,
        auth_headers: JSON.parse(values[2] as string) as Record<string, string | null>,
      });
      return Promise.resolve(1);
    }
    if (text.includes('INSERT INTO public.og_traffic_search_state')) {
      calls.commits.push(values);
      return Promise.resolve(script.commitChanges);
    }
    return Promise.reject(new Error(`unscripted execute: ${text}`));
  };

  const fake = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    $executeRawUnsafe: (sql: string) => {
      calls.executed.push(sql);
      return Promise.resolve(0);
    },
    $transaction: (fn: (tx: unknown) => Promise<unknown>, options: unknown) => {
      calls.txOptions.push(options);
      return fn(fake);
    },
    apiDefinition: { findMany: () => Promise.resolve(script.apis) },
  };
  const store = {
    retentionDays: () => 30,
    ensurePartitions: jest.fn(() => Promise.resolve()),
    maintain: jest.fn(() => Promise.resolve(true)),
  };
  const config = { get: () => undefined } as unknown as ConfigService;
  const indexer = new TrafficSearchIndexerService(fake as unknown as PrismaClient, config, store as unknown as TrafficSearchStoreService);
  return { indexer, script, calls, store };
}

let warn: jest.SpyInstance;
let log: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  mockYields.mockClear();
  searchSkippedRowsTotal.reset();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('the indexer: one scan at a time', () => {
  it('a second scan while one is running is skipped, and says so; the first one finishes normally', async () => {
    let release: () => void = () => undefined;
    const { indexer, script } = setup();
    script.pages = [[captured(1)]];
    const original = jest.spyOn(indexer as unknown as { readPage: () => Promise<CapturedRow[]> }, 'readPage');
    original.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve([]);
          };
        }),
    );
    const first = indexer.tick(NOW);
    await new Promise(setImmediate);
    expect(await indexer.tick(NOW)).toEqual({ inserted: 0, skipped: 0, reason: 'skipped-running' });
    expect(await indexer.scan(new Date(NOW.getTime() - 1000), NOW, false)).toMatchObject({ reason: 'skipped-running' });
    release();
    expect(await first).toMatchObject({ reason: 'ok' });
    // The guard is released afterwards.
    expect(await indexer.tick(NOW)).toMatchObject({ reason: 'ok' });
  });

  it('releases the guard when a scan fails', async () => {
    const { indexer, script } = setup({ state: new Error('boom') });
    expect(await indexer.tick(NOW)).toMatchObject({ reason: 'error' });
    script.state = stateRow();
    expect(await indexer.tick(NOW)).toMatchObject({ reason: 'ok' });
  });
});

describe('the indexer: a row Postgres refuses', () => {
  const page = (n: number): CapturedRow[] => Array.from({ length: n }, (_, i) => captured(i));

  it('finds it by halving the page, skips it, lands every other row, counts it, and still moves the watermark', async () => {
    const { indexer, calls } = setup({ pages: [page(8)], refuse: new Map([['k5', dataError()]]) });
    const outcome = await indexer.tick(NOW);

    expect(outcome).toEqual({ inserted: 7, skipped: 1, reason: 'ok' });
    const landed = calls.inserts.filter((i) => !i.keys.includes('k5')).flatMap((i) => i.keys);
    expect(new Set(landed)).toEqual(new Set(['k0', 'k1', 'k2', 'k3', 'k4', 'k6', 'k7']));
    // 8 -> 4+4 -> (the half with k5) 2+2 -> 1+1: a handful of statements, not one per row.
    expect(calls.inserts.length).toBeLessThanOrEqual(9);
    expect(calls.commits).toHaveLength(1); // the watermark advanced: one row cannot block the queue
    expect((await searchSkippedRowsTotal.get()).values[0]?.value).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dedupe_key k5'));
  });

  it('does not try a refused row again on the next tick, which re-reads the lookback', async () => {
    const { indexer, calls } = setup({ pages: [page(4)], refuse: new Map([['k2', dataError()]]) });
    await indexer.tick(NOW);
    calls.inserts.length = 0;
    const again = await indexer.tick(NOW);
    expect(again).toMatchObject({ inserted: 3, skipped: 0, reason: 'ok' });
    expect(calls.inserts.flatMap((i) => i.keys)).not.toContain('k2');
    expect((await searchSkippedRowsTotal.get()).values[0]?.value).toBe(1); // counted once
  });

  it('a page where every row is refused is skipped whole, and still does not throw', async () => {
    const { indexer } = setup({ pages: [page(3)], refuse: new Map([['*', dataError()]]) });
    expect(await indexer.tick(NOW)).toEqual({ inserted: 0, skipped: 3, reason: 'ok' });
  });

  it('only splits an error that is about a VALUE: a connection failure is thrown, not halved', async () => {
    const { indexer, calls } = setup({ pages: [page(8)], refuse: new Map([['*', connectionError()]]) });
    expect(await indexer.tick(NOW)).toMatchObject({ reason: 'error' });
    expect(calls.inserts).toHaveLength(1);
    expect(calls.commits).toHaveLength(0); // the watermark did not move: the next tick retries
  });

  it.each([
    ['a data exception by SQLSTATE', Object.assign(new Error('x'), { meta: { code: '22P05' } })],
    ['a program limit', Object.assign(new Error('x'), { meta: { code: '54000' } })],
    ['the code in the message', new Error('Raw query failed. Code: `22P02`. Message: `invalid input syntax for type json`')],
    ['the words alone', new Error('invalid byte sequence for encoding "UTF8"')],
  ])('treats %s as a refused value', async (_label, error) => {
    const { indexer } = setup({ pages: [page(2)], refuse: new Map([['k1', error]]) });
    expect(await indexer.tick(NOW)).toEqual({ inserted: 1, skipped: 1, reason: 'ok' });
  });

  it.each([
    ['a statement timeout', Object.assign(new Error('x'), { meta: { code: '57014' } })],
    ['a lock timeout', Object.assign(new Error('x'), { meta: { code: '55P03' } })],
    ['a missing relation is its own reason, not a refused row', Object.assign(new Error('x'), { meta: { code: '42P01' } })],
  ])('does not mistake %s for a refused value', async (_label, error) => {
    const { indexer, calls } = setup({ pages: [page(4)], refuse: new Map([['*', error]]) });
    const outcome = await indexer.tick(NOW);
    expect(['error', 'table-missing']).toContain(outcome.reason);
    expect(calls.inserts).toHaveLength(1);
  });

  it('writes under the generation the scan started with, so a reset in between makes the insert a no-op', async () => {
    const { indexer, calls } = setup({ pages: [page(2)], state: stateRow({ generation: 7n }) });
    await indexer.tick(NOW);
    expect(calls.inserts[0]?.generation).toBe(7);
    expect(calls.commits[0]?.[2]).toBe(7);
  });
});

describe('the indexer: the watermark', () => {
  it('moves forward only after the window was copied, to the end of it', async () => {
    const { indexer, calls } = setup({ pages: [[captured(1)]] });
    await indexer.tick(NOW);
    expect(calls.commits).toHaveLength(1);
    expect(calls.commits[0]?.[0]).toBe(NOW.toISOString());
  });

  it('does not move when the scan fails', async () => {
    const { indexer, calls } = setup({ pages: [[captured(1)]], refuse: new Map([['*', connectionError()]]) });
    await indexer.tick(NOW);
    expect(calls.commits).toHaveLength(0);
  });

  it('an explicit scan with advance off records nothing', async () => {
    const { indexer, calls } = setup({ pages: [[captured(1)]] });
    await indexer.scan(new Date(NOW.getTime() - 3_600_000), NOW, false);
    expect(calls.commits).toHaveLength(0);
  });

  it('re-reads the lookback behind the watermark, not from it', async () => {
    const scannedUntil = new Date('2026-09-29T11:30:00.000Z');
    const { indexer, calls } = setup({ state: stateRow({ scanned_until: scannedUntil }) });
    await indexer.tick(NOW);
    expect((calls.pageParams[0]?.[0] as Date).toISOString()).toBe('2026-09-29T11:15:00.000Z');
    expect((calls.pageParams[0]?.[1] as Date).toISOString()).toBe(NOW.toISOString());
  });

  it('with no state at all it starts the first run a backfill window back, and records where it began', async () => {
    const { indexer, calls } = setup({ state: null });
    await indexer.tick(NOW);
    expect((calls.pageParams[0]?.[0] as Date).toISOString()).toBe('2026-09-22T12:00:00.000Z');
    expect((calls.commits[0]?.[1] as Date).toISOString()).toBe('2026-09-22T12:00:00.000Z');
    expect(calls.commits[0]?.[2]).toBe(0);
  });

  it('records the generation it found as progress, and says superseded when a reset took the table from under it', async () => {
    const { indexer } = setup({ pages: [[captured(1)]], commitChanges: 0 });
    expect(await indexer.tick(NOW)).toMatchObject({ reason: 'superseded' });
  });

  it('sets the age gauge from the state, in seconds, on every tick that can read it', async () => {
    const { indexer } = setup({ state: stateRow({ scanned_until: new Date(NOW.getTime() - 90_000) }), triggerPresent: false });
    await indexer.tick(NOW);
    expect((await searchIndexedAgeSeconds.get()).values[0]?.value).toBe(90);
  });
});

describe('the indexer: a watermark it cannot read', () => {
  it('skips the tick with an error instead of treating it as "no watermark" and starting a backfill', async () => {
    const { indexer, calls } = setup({ state: new Error('connection reset') });
    expect(await indexer.tick(NOW)).toMatchObject({ reason: 'error' });
    expect(calls.queries.some((q) => q.includes('FROM public.tyk_analytics'))).toBe(false); // nothing was scanned
    expect(calls.commits).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
  });

  it('a missing state table is "table missing", and asks the upkeep to create it, at most every few minutes', async () => {
    const { indexer, store } = setup({ state: Object.assign(new Error('relation "public.og_traffic_search_state" does not exist'), { meta: { code: '42P01' } }) });
    expect(await indexer.tick(NOW)).toMatchObject({ reason: 'table-missing' });
    expect(await indexer.tick(NOW)).toMatchObject({ reason: 'table-missing' });
    expect(store.maintain).toHaveBeenCalledTimes(1);
  });

  it('indexedUntil and indexedFrom throw on a failed read, and say null only when there is no row', async () => {
    const failing = setup({ state: new Error('boom') });
    await expect(failing.indexer.indexedUntil()).rejects.toThrow('boom');
    await expect(failing.indexer.indexedFrom()).rejects.toThrow('boom');
    const empty = setup({ state: null });
    await expect(empty.indexer.indexedUntil()).resolves.toBeNull();
    await expect(empty.indexer.indexedFrom()).resolves.toBeNull();
    const there = setup({ state: stateRow() });
    await expect(there.indexer.indexedUntil()).resolves.toEqual(new Date(NOW.getTime() - 60_000));
    await expect(there.indexer.indexedFrom()).resolves.toEqual(new Date(NOW.getTime() - 7 * 86_400_000));
  });
});

describe('the indexer: retention', () => {
  it('does not insert a row older than the retention window', async () => {
    const old = captured(1, { ts_iso: '2026-08-01T10:00:00.000000Z', dedupe_key: 'old' });
    const fresh = captured(2, { ts_iso: '2026-09-29T11:00:00.000000Z', dedupe_key: 'fresh' });
    const { indexer, calls } = setup({ pages: [[old, fresh]] });
    const outcome = await indexer.scan(new Date('2026-07-30T00:00:00Z'), NOW, false);
    expect(outcome.inserted).toBe(1);
    expect(calls.inserts.flatMap((i) => i.keys)).toEqual(['fresh']);
  });
});

describe('the indexer: why a scan returned nothing', () => {
  it('paused: no trigger, no scan; logged once while it stays that way, and again when it is back', async () => {
    const { indexer, script, calls } = setup({ triggerPresent: false });
    expect(await indexer.tick(NOW)).toEqual({ inserted: 0, skipped: 0, reason: 'paused' });
    await indexer.tick(NOW);
    await indexer.scan(new Date(NOW.getTime() - 1000), NOW, false);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('paused'))).toHaveLength(1);
    expect(calls.queries.some((q) => q.includes('FROM public.tyk_analytics'))).toBe(false);

    script.triggerPresent = true;
    expect(await indexer.tick(NOW)).toMatchObject({ reason: 'ok' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('resumed'));
    script.triggerPresent = false;
    await indexer.tick(NOW);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('paused'))).toHaveLength(2);
  });

  it('table-missing: the search table is absent', async () => {
    const { indexer, store } = setup({ tablePresent: false });
    expect(await indexer.tick(NOW)).toEqual({ inserted: 0, skipped: 0, reason: 'table-missing' });
    expect(store.maintain).toHaveBeenCalledTimes(1);
  });

  it('table-missing: the pump table is absent, which Postgres reports as 42P01 mid-scan', async () => {
    const { indexer } = setup();
    jest.spyOn(indexer as unknown as { readPage: () => Promise<CapturedRow[]> }, 'readPage').mockRejectedValue(
      Object.assign(new Error('relation "public.tyk_analytics" does not exist'), { meta: { code: '42P01' } }),
    );
    expect(await indexer.tick(NOW)).toMatchObject({ reason: 'table-missing' });
  });

  it('ok with nothing to copy is ok, not a failure', async () => {
    const { indexer } = setup({ pages: [[]] });
    expect(await indexer.tick(NOW)).toEqual({ inserted: 0, skipped: 0, reason: 'ok' });
  });

  it('error: anything else, as a reason and a warning, never a throw', async () => {
    const { indexer } = setup();
    jest.spyOn(indexer as unknown as { readPage: () => Promise<CapturedRow[]> }, 'readPage').mockRejectedValue(new Error('disk full'));
    await expect(indexer.tick(NOW)).resolves.toMatchObject({ reason: 'error' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });
});

describe('the indexer: bounded work', () => {
  const fullPage = (from: number): CapturedRow[] => Array.from({ length: 500 }, (_, i) => captured(from + i, { dedupe_key: `k${String(from + i)}` }));

  it('stops after its time budget, records how far it got, and carries on from there at the next tick', async () => {
    let clock = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => {
      clock += 3000; // each read of the clock is 3 s later: the 8 s budget is gone after a few pages
      return clock;
    });
    const { indexer, calls, script } = setup({ pages: [fullPage(0), fullPage(500), fullPage(1000), fullPage(1500), []] });
    const outcome = await indexer.tick(NOW);

    expect(outcome.reason).toBe('budget');
    expect(calls.commits).toHaveLength(1);
    const until = calls.commits[0]?.[0] as string;
    expect(until).not.toBe(NOW.toISOString()); // not "the whole window": only as far as the last page it finished
    expect(until).toMatch(/^2026-09-29T11:\d\d:00\.000001Z$/);
    expect(script.pages.length).toBeGreaterThan(calls.pageParams.length); // it did not read every page
  });

  it('a short page is the end: no budget stop, the watermark goes to the end of the window', async () => {
    jest.spyOn(performance, 'now').mockReturnValue(1e9);
    const { indexer, calls } = setup({ pages: [[captured(1)]] });
    const outcome = await indexer.tick(NOW);
    expect(outcome.reason).toBe('ok');
    expect(calls.commits[0]?.[0]).toBe(NOW.toISOString());
  });

  it('gives the event loop back by elapsed time, not by row count', async () => {
    let clock = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => {
      clock += 25; // every row "takes" 25 ms: longer than the 20 ms slice
      return clock;
    });
    const { indexer } = setup({ pages: [Array.from({ length: 10 }, (_, i) => captured(i))] });
    await indexer.tick(NOW);
    expect(mockYields.mock.calls.length).toBeGreaterThanOrEqual(10);
  });

  it('does not yield when the rows are cheap: nothing to give back', async () => {
    jest.spyOn(performance, 'now').mockReturnValue(5);
    const { indexer } = setup({ pages: [Array.from({ length: 200 }, (_, i) => captured(i))] });
    await indexer.tick(NOW);
    expect(mockYields).not.toHaveBeenCalled();
  });

  it('every indexer statement runs in a transaction with a statement timeout', async () => {
    const { indexer, calls } = setup({ pages: [[captured(1)]] });
    await indexer.tick(NOW);
    const timeouts = calls.executed.filter((q) => q.includes('SET LOCAL statement_timeout'));
    expect(timeouts.length).toBeGreaterThanOrEqual(2); // the page read and the insert
    expect(timeouts.every((q) => q.endsWith("statement_timeout = 30000"))).toBe(true);
  });
});

describe('the indexer: rows built under old rules', () => {
  it('rebuilds (empties the table, raises the generation) when the rules tag differs, then scans the whole retention window', async () => {
    const { indexer, calls } = setup({ state: stateRow({ redaction_tag: 'proj:old' }) });
    const outcome = await indexer.tick(NOW);
    expect(calls.resets).toBe(1);
    expect(calls.executed.some((q) => q.includes('TRUNCATE public.og_traffic_search'))).toBe(true);
    expect(outcome.reason).toBe('ok');
    // The rebuild reads from the retention floor (30 days), not from "a minute ago" or the 7-day first run.
    expect((calls.pageParams[0]?.[0] as Date).getTime()).toBe(NOW.getTime() - FLOOR_MS - 15 * 60_000);
    expect(calls.inserts.length + calls.commits.length).toBeGreaterThan(0);
    expect(calls.commits[0]?.[2]).toBe(4); // under the NEW generation
  });

  it('a row table from before the tag existed (null) is rebuilt as well', async () => {
    const { indexer, calls } = setup({ state: stateRow({ redaction_tag: null }) });
    await indexer.tick(NOW);
    expect(calls.resets).toBe(1);
  });

  it('does not rebuild twice: the installer\'s own reset leaves the pending tag, which the indexer adopts', async () => {
    const { indexer, calls } = setup({ state: stateRow({ redaction_tag: TAG_PENDING, indexed_from: null }) });
    await indexer.tick(NOW);
    expect(calls.resets).toBe(0);
    expect(calls.commits[0]?.[3]).toBe(tag); // and records its own from now on
  });

  it('does not rebuild when nothing changed', async () => {
    const { indexer, calls } = setup();
    await indexer.tick(NOW);
    expect(calls.resets).toBe(0);
  });

  it('rebuilds when an existing API\'s auth header changed, but not for a new or a removed API', async () => {
    const changed = setup({
      state: stateRow({ auth_headers: { 'tyk-a': 'X-Old' } }),
      apis: [{ tykApiId: 'tyk-a', config: { authHeaderName: 'X-New' } }],
    });
    await changed.indexer.tick(NOW);
    expect(changed.calls.resets).toBe(1);

    const added = setup({
      state: stateRow({ auth_headers: { 'tyk-a': 'X-Same' }, }),
      apis: [
        { tykApiId: 'tyk-a', config: { authHeaderName: 'X-Same' } },
        { tykApiId: 'tyk-b', config: { authHeaderName: 'X-Brand-New' } },
      ],
    });
    await added.indexer.tick(NOW);
    expect(added.calls.resets).toBe(0);

    const removed = setup({ state: stateRow({ auth_headers: { 'tyk-a': 'X-A', 'tyk-gone': 'X-G' } }), apis: [{ tykApiId: 'tyk-a', config: { authHeaderName: 'X-A' } }] });
    await removed.indexer.tick(NOW);
    expect(removed.calls.resets).toBe(0);
  });

  it('records the auth headers it indexed under, so the next change is seen', async () => {
    const { indexer, calls } = setup({ state: null, apis: [{ tykApiId: 'tyk-a', config: { authHeaderName: 'X-Tenant' } }] });
    await indexer.tick(NOW);
    expect(JSON.parse(calls.commits[0]?.[4] as string)).toEqual({ 'tyk-a': 'X-Tenant' });
  });
});
