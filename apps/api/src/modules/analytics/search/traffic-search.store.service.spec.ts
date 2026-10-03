import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { jobRunsTotal, searchMaintenanceFailuresTotal } from '../../../common/metrics/ops-metrics';
import { TrafficSearchStoreService } from './traffic-search.store.service';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const pgError = (code: string, message = 'failed'): Error => Object.assign(new Error(message), { meta: { code } });
const textOf = (q: unknown): string => (Array.isArray(q) ? (q as string[]).join('?') : String(q));

interface Script {
  /** DDL (`$queryRawUnsafe`/`$executeRawUnsafe` text) -> errors thrown for the next calls, in order. */
  fail: Map<RegExp, Error[]>;
  partitions: string[];
}

function setup(over: Partial<Script> = {}, config: Record<string, string> = {}) {
  const script: Script = { fail: new Map(), partitions: [], ...over };
  const log: string[] = [];
  const transactions: string[][] = [];
  const maybeFail = (sql: string): Promise<void> => {
    for (const [pattern, errors] of script.fail) {
      if (pattern.test(sql) && errors.length > 0) return Promise.reject(errors.shift() ?? new Error('no error scripted'));
    }
    return Promise.resolve();
  };
  const tx = {
    // The lock: `$executeRaw`, as `$queryRaw` cannot deserialize the void column of pg_advisory_xact_lock (a real-Postgres failure).
    $executeRaw: (strings: TemplateStringsArray) => {
      const sql = textOf(strings);
      log.push(sql);
      transactions.at(-1)?.push(sql);
      return maybeFail(sql).then(() => 0);
    },
    $queryRawUnsafe: (sql: string) => {
      log.push(sql);
      transactions.at(-1)?.push(sql);
      return maybeFail(sql).then(() => []);
    },
    $executeRawUnsafe: (sql: string) => {
      log.push(sql);
      transactions.at(-1)?.push(sql);
      return maybeFail(sql).then(() => 0);
    },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => {
      transactions.push([]);
      return fn(tx);
    },
    $queryRaw: () => Promise.resolve(script.partitions.map((name) => ({ name }))),
  } as unknown as PrismaClient;
  const configService = { get: (k: string) => config[k] } as unknown as ConfigService;
  return { store: new TrafficSearchStoreService(prisma, configService), script, log, transactions };
}

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jobRunsTotal.reset();
  searchMaintenanceFailuresTotal.reset();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const jobs = async () => (await jobRunsTotal.get()).values.map(({ labels, value }) => [labels.task, labels.outcome, value]);
const failures = async () => (await searchMaintenanceFailuresTotal.get()).values.map(({ labels, value }) => [labels.phase, value]);

describe('TrafficSearchStoreService.maintain', () => {
  it('creates the table and three partitions, each DDL under the advisory lock, and records one good run', async () => {
    const { store, transactions } = setup();
    expect(await store.maintain(NOW)).toBe(true);
    expect(transactions).toHaveLength(4); // the table, then today and the two days ahead
    for (const t of transactions) expect(t[0]).toContain('pg_advisory_xact_lock');
    expect(transactions[0]?.[1]).toContain('CREATE TABLE IF NOT EXISTS public.og_traffic_search');
    expect(transactions[1]?.[1]).toContain('og_traffic_search_20260929');
    expect(transactions[3]?.[1]).toContain('og_traffic_search_20261001');
    expect(await jobs()).toEqual([['search_maintenance', 'ok', 1]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failing phase is logged BY NAME and counted, and does not stop the phases after it', async () => {
    const { store, transactions, script } = setup({ fail: new Map([[/CREATE TABLE IF NOT EXISTS public\.og_traffic_search\b(?!_)/, [pgError('42501', 'permission denied')]]]) });
    script.partitions = ['og_traffic_search_20260101'];
    expect(await store.maintain(NOW)).toBe(false);

    expect(transactions.length).toBeGreaterThanOrEqual(5); // table (failed), three partitions, the drop of an expired one
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(create)'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
    expect(await failures()).toEqual([['create', 1]]);
    expect(await jobs()).toEqual([['search_maintenance', 'error', 1]]);
  });

  it('a partition that cannot be created names that partition, and the other days are still created', async () => {
    const { store, transactions } = setup({ fail: new Map([[/og_traffic_search_20260930 PARTITION OF/, [pgError('42501', 'permission denied')]]]) });
    expect(await store.maintain(NOW)).toBe(false);
    const created = transactions.map((t) => t[1] ?? '').filter((sql) => sql.includes('PARTITION OF'));
    expect(created.some((sql) => sql.includes('og_traffic_search_20261001'))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('og_traffic_search_20260930'));
    expect(await failures()).toEqual([['partition_create', 1]]);
  });

  it('an expired partition that cannot be dropped does not keep another from being dropped, and only the dropped ones count', async () => {
    const { store, script } = setup({
      partitions: ['og_traffic_search_20260101', 'og_traffic_search_20260102', 'og_traffic_search_20260929'],
      fail: new Map([[/DROP TABLE IF EXISTS public\.og_traffic_search_20260101/, [pgError('42501', 'must be owner')]]]),
    });
    expect(script.partitions).toHaveLength(3);
    await expect(store.dropExpired(NOW)).resolves.toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('og_traffic_search_20260101'));
    expect(await failures()).toEqual([['partition_drop', 1]]);
  });
});

describe('concurrent DDL', () => {
  it.each(['42P07', '23505'])('retries once after SQLSTATE %s, which another session creating the same object raises', async (code) => {
    jest.useFakeTimers();
    const { store, transactions } = setup({ fail: new Map([[/PARTITION OF/, [pgError(code)]]]) });
    const done = store.ensurePartitions([NOW]);
    await jest.advanceTimersByTimeAsync(300);
    await expect(done).resolves.toBeUndefined();
    expect(transactions).toHaveLength(2); // the failed attempt and the one that worked
  });

  it('gives up after the second such failure, and does not retry any other error at all', async () => {
    jest.useFakeTimers();
    const twice = setup({ fail: new Map([[/PARTITION OF/, [pgError('42P07'), pgError('42P07')]]]) });
    const done = twice.store.ensurePartitions([NOW]);
    const caught = done.catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(300);
    expect(await caught).toBeInstanceOf(Error);
    expect(twice.transactions).toHaveLength(2);

    const other = setup({ fail: new Map([[/PARTITION OF/, [pgError('42501', 'permission denied')]]]) });
    await expect(other.store.ensurePartitions([NOW])).rejects.toThrow('permission denied');
    expect(other.transactions).toHaveLength(1);
  });
});

describe('dropping a partition', () => {
  const expired = ['og_traffic_search_20260101'];

  it('sets a lock timeout in the same transaction as the DROP, so a lock it cannot get is given up, not queued behind', async () => {
    const { store, transactions } = setup({ partitions: expired });
    await store.dropExpired(NOW);
    expect(transactions[0]).toEqual([`SET LOCAL lock_timeout = '3s'`, 'DROP TABLE IF EXISTS public.og_traffic_search_20260101']);
  });

  it('retries a lock timeout a second apart, up to three tries, then leaves the partition for the next run', async () => {
    jest.useFakeTimers();
    const lock = (): Error => pgError('55P03', 'canceling statement due to lock timeout');
    const { store, transactions } = setup({ partitions: expired, fail: new Map([[/DROP TABLE/, [lock(), lock(), lock()]]]) });
    const done = store.dropExpired(NOW);
    await jest.advanceTimersByTimeAsync(2500);
    await expect(done).resolves.toBe(0);
    expect(transactions).toHaveLength(3);
    expect(await failures()).toEqual([['partition_drop', 1]]);
  });

  it('a lock that frees on the second try drops it', async () => {
    jest.useFakeTimers();
    const { store } = setup({ partitions: expired, fail: new Map([[/DROP TABLE/, [pgError('55P03')]]]) });
    const done = store.dropExpired(NOW);
    await jest.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toBe(1);
    expect(await failures()).toEqual([]);
  });

  it('only ever drops what looks like one of its own partitions', async () => {
    const { store, transactions } = setup({ partitions: ['og_traffic_search_20260101', 'og_traffic_search_state', 'tyk_analytics'] });
    await expect(store.dropExpired(NOW)).resolves.toBe(1);
    expect(transactions).toHaveLength(1);
  });
});

describe('retentionDays', () => {
  it.each([
    [undefined, 30],
    ['', 30],
    ['abc', 30],
    ['0', 30],
    ['-5', 30],
    ['1.5', 30],
    ['45', 45],
    ['100000000', 3650], // 1e8 days would make `addDays` an invalid Date, and every comparison with it false
    ['3650', 3650],
  ])('%j gives %i', (value, expected) => {
    const { store } = setup({}, value === undefined ? {} : { ANALYTICS_RETENTION_DAYS: value });
    expect(store.retentionDays()).toBe(expected);
  });
});
