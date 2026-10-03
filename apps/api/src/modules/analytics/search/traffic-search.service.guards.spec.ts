import { ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { TrafficSearchService } from './traffic-search.service';

/**
 * What the search endpoint says when the index is not what it should be, and its limits. (The query, the tenant
 * scope and the paging are in `traffic-search.service.spec.ts`.)
 */

const ago = (ms: number): Date => new Date(Date.now() - ms);
const DAY = 86_400_000;
const pgError = (code: string, message = 'Raw query failed'): Error => Object.assign(new Error(message), { meta: { code } });

const API = { id: 'def-1', name: 'Orders API', slug: 'orders-api', tykApiId: 'tyk-a' };

interface Options {
  until?: Date | null | Error;
  /** `undefined` leaves the indexer without an `indexedFrom` at all (an older stub or build). */
  from?: Date | null | Error | undefined;
  query?: () => Promise<unknown[]>;
  config?: Record<string, string>;
}

function setup(options: Options = {}) {
  const executed: string[] = [];
  const tx = {
    $executeRawUnsafe: (sql: string) => {
      executed.push(sql);
      return Promise.resolve(0);
    },
    $queryRaw: () => (options.query ? options.query() : Promise.resolve([])),
  };
  const prisma = {
    apiDefinition: { findMany: () => Promise.resolve([API]) },
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
  const settle = (v: Date | null | Error | undefined): Promise<Date | null> => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? null));
  const indexer: { indexedUntil: () => Promise<Date | null>; indexedFrom?: () => Promise<Date | null> } = {
    indexedUntil: () => settle(options.until === undefined ? ago(5000) : options.until),
  };
  // Left out of the options: a table that began 10 days ago. Given as `undefined`: an indexer with no `indexedFrom` at all.
  if (!('from' in options)) indexer.indexedFrom = () => Promise.resolve(ago(10 * DAY));
  else if (options.from !== undefined) indexer.indexedFrom = () => settle(options.from);
  const config = { get: (k: string) => options.config?.[k] } as unknown as ConfigService;
  return { service: new TrafficSearchService(prisma, config, indexer), executed };
}

describe('TrafficSearchService: what the person is told about coverage', () => {
  it('complete: the table covers the whole window up to now, so an empty result is real', async () => {
    const page = await setup({ until: ago(10_000), from: ago(2 * DAY) }).service.search('t1', { range: '24h' });
    expect(page.coverage).toBe('complete');
    expect(typeof page.indexedFrom).toBe('string');
    expect(typeof page.indexedUntil).toBe('string');
  });

  it('partial: the window starts before the table does (a 30-day search of a table that began 7 days ago)', async () => {
    const page = await setup({ until: ago(10_000), from: ago(7 * DAY) }).service.search('t1', { range: '30d' });
    expect(page.coverage).toBe('partial');
    expect(Date.parse(page.indexedFrom ?? '')).toBeLessThan(Date.now() - 6 * DAY);
  });

  it('partial for a short window the same table does cover completely: the claim is per window', async () => {
    const { service } = setup({ until: ago(10_000), from: ago(6 * DAY) });
    expect((await service.search('t1', { range: '24h' })).coverage).toBe('complete');
    expect((await service.search('t1', { range: '7d' })).coverage).toBe('partial'); // 7 days back is a day before the table starts
  });

  it('partial: the index has stalled, or is still catching up after a rebuild, so recent requests may not be in it', async () => {
    const page = await setup({ until: ago(40 * 60_000), from: ago(2 * DAY) }).service.search('t1', { range: '24h' });
    expect(page.coverage).toBe('partial');
  });

  it('none: nothing has been indexed yet', async () => {
    const page = await setup({ until: null, from: null }).service.search('t1', {});
    expect(page).toMatchObject({ coverage: 'none', indexedUntil: null, indexedFrom: null });
  });

  it('partial, never complete, when the start of coverage is not known', async () => {
    expect((await setup({ until: ago(1000), from: null }).service.search('t1', {})).coverage).toBe('partial');
    expect((await setup({ until: ago(1000), from: undefined }).service.search('t1', {})).coverage).toBe('partial');
  });
});

describe('TrafficSearchService: a state it cannot read, and tables that are not there', () => {
  it('a failed read of the state is a 503 SEARCH_INDEX_UNAVAILABLE, not an empty "has not started" page', async () => {
    const { service } = setup({ until: new Error('connection reset') });
    await expect(service.search('t1', {})).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.search('t1', {})).rejects.toMatchObject({ response: { error: 'SEARCH_INDEX_UNAVAILABLE' } });
    await expect(setup({ from: new Error('boom') }).service.search('t1', {})).rejects.toMatchObject({ status: 503 });
  });

  it('the 503 does not repeat the database\'s own words to the caller', async () => {
    const { service } = setup({ until: new Error('password authentication failed for user "og"') });
    await expect(service.search('t1', {})).rejects.toMatchObject({ response: { message: expect.not.stringContaining('password') as unknown } });
  });

  it('a missing state table is a clean "not ready" page with nothing indexed, not an error', async () => {
    const { service } = setup({ until: pgError('42P01', 'relation "public.og_traffic_search_state" does not exist') });
    expect(await service.search('t1', {})).toEqual({
      range: '24h',
      items: [],
      hasMore: false,
      nextCursor: null,
      indexedUntil: null,
      indexedFrom: null,
      coverage: 'none',
    });
  });

  it('a missing search table, found by the query itself, is the same clean page', async () => {
    const { service } = setup({ query: () => Promise.reject(pgError('42P01')) });
    expect(await service.search('t1', { range: '7d' })).toMatchObject({ range: '7d', items: [], coverage: 'none' });
  });

  it('any other query failure still reaches the caller unchanged', async () => {
    const boom = new Error('connection refused');
    await expect(setup({ query: () => Promise.reject(boom) }).service.search('t1', {})).rejects.toBe(boom);
  });
});

describe('TrafficSearchService: limits', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['not a number', 'fast'],
  ])('a TRAFFIC_SEARCH_TIMEOUT_MS that is %s is the default 3000 ms, not 100 ms', async (_label, value) => {
    const { service, executed } = setup({ config: value === undefined ? {} : { TRAFFIC_SEARCH_TIMEOUT_MS: value } });
    await service.search('t1', {});
    expect(executed).toEqual(['SET LOCAL statement_timeout = 3000']);
  });

  it('a real value is still used, and clamped', async () => {
    for (const [value, expected] of [['2500', 2500], ['1', 100], ['999999', 10_000]] as const) {
      const { service, executed } = setup({ config: { TRAFFIC_SEARCH_TIMEOUT_MS: value } });
      await service.search('t1', {});
      expect(executed).toEqual([`SET LOCAL statement_timeout = ${String(expected)}`]);
    }
  });

  it('maps a cancelled statement to 422 when Prisma carries the SQLSTATE only in meta.code', async () => {
    const { service } = setup({ query: () => Promise.reject(pgError('57014', 'Raw query failed')) });
    await expect(service.search('t1', {})).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(service.search('t1', {})).rejects.toMatchObject({ response: { error: 'SEARCH_TOO_BROAD' } });
  });

  describe('the process-wide cap on running searches', () => {
    const hold = (n: number, config: Record<string, string> = {}) => {
      const pending: (() => void)[] = [];
      const made = setup({
        config,
        query: () =>
          new Promise<unknown[]>((resolve) => {
            pending.push(() => {
              resolve([]);
            });
          }),
      });
      const running = Array.from({ length: n }, (_, i) => made.service.search(`tenant-${String(i)}`, {}));
      return { ...made, pending, running };
    };

    it('lets 3 searches run at once whoever asks, and answers the 4th 429 SEARCH_BUSY', async () => {
      const { service, pending, running } = hold(3);
      await new Promise(setImmediate);
      expect(pending).toHaveLength(3);
      await expect(service.search('tenant-other', {})).rejects.toMatchObject({ status: 429, response: { error: 'SEARCH_BUSY' } });
      for (const release of pending.splice(0)) release();
      await Promise.all(running);
    });

    it('frees the slot when a search ends, and when one fails', async () => {
      const { service, pending, running } = hold(3);
      await new Promise(setImmediate);
      pending.shift()?.();
      await running[0];
      const next = service.search('tenant-next', {});
      await new Promise(setImmediate);
      expect(pending).toHaveLength(3); // the two still running and the new one
      for (const release of pending.splice(0)) release();
      await Promise.all([next, ...running]);

      const failing = setup({ query: () => Promise.reject(new Error('boom')) });
      for (let i = 0; i < 6; i++) await expect(failing.service.search(`t${String(i)}`, {})).rejects.toThrow('boom');
    });

    it('is configurable, within limits', async () => {
      const wide = hold(5, { TRAFFIC_SEARCH_MAX_CONCURRENT: '5' });
      await new Promise(setImmediate);
      expect(wide.pending).toHaveLength(5);
      for (const release of wide.pending.splice(0)) release();
      await Promise.all(wide.running);

      const one = hold(1, { TRAFFIC_SEARCH_MAX_CONCURRENT: '1' });
      await new Promise(setImmediate);
      await expect(one.service.search('tenant-b', {})).rejects.toMatchObject({ status: 429 });
      for (const release of one.pending.splice(0)) release();
      await Promise.all(one.running);

      // Garbage is the default, not "no limit" and not "no searches".
      const junk = hold(3, { TRAFFIC_SEARCH_MAX_CONCURRENT: 'many' });
      await new Promise(setImmediate);
      expect(junk.pending).toHaveLength(3);
      await expect(junk.service.search('tenant-b', {})).rejects.toMatchObject({ status: 429 });
      for (const release of junk.pending.splice(0)) release();
      await Promise.all(junk.running);
    });
  });
});
