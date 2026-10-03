import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import {
  isDataError,
  isLockTimeout,
  isMissingRelation,
  queryWithTimeout,
  SearchTimeoutError,
  sqlState,
  withStatementTimeout,
} from './traffic-search.query';

/** An error the way Prisma raises a failed raw query: the SQLSTATE in `meta.code`, and a message that may not mention it at all. */
const prismaError = (code: string, message = 'Raw query failed'): Error => Object.assign(new Error(message), { meta: { code } });

describe('sqlState', () => {
  it('reads Prisma\'s meta.code, then the code in the message, then nothing', () => {
    expect(sqlState(prismaError('22021'))).toBe('22021');
    expect(sqlState(new Error('Raw query failed. Code: `57014`. Message: `canceling statement`'))).toBe('57014');
    expect(sqlState(new Error('connection refused'))).toBeNull();
    expect(sqlState(null)).toBeNull();
    expect(sqlState('plain string')).toBeNull();
  });

  it('ignores a meta.code that is not a SQLSTATE (Prisma\'s own P2010 sits one level up)', () => {
    expect(sqlState(Object.assign(new Error('x'), { code: 'P2010', meta: { code: 'P2010x' } }))).toBeNull();
  });

  it('prefers meta.code over a different code in the text', () => {
    expect(sqlState(Object.assign(new Error('Code: `22021`'), { meta: { code: '42P01' } }))).toBe('42P01');
  });
});

describe('error classes', () => {
  it('a data error is a value Postgres refused: class 22 or 54, by code, by message code, or by its words', () => {
    for (const code of ['22021', '22P02', '22P05', '54000']) expect(isDataError(prismaError(code))).toBe(true);
    expect(isDataError(new Error('Code: `22P05`'))).toBe(true);
    expect(isDataError(new Error('unsupported Unicode escape sequence'))).toBe(true);
    expect(isDataError(new Error('string is too long for tsvector (1500000 bytes, max 1048575 bytes)'))).toBe(true);
    // Not about a value: halving the rows cannot help.
    for (const code of ['57014', '55P03', '42P01', '08006', '40001', '53300']) expect(isDataError(prismaError(code))).toBe(false);
    expect(isDataError(new Error("Can't reach database server"))).toBe(false);
  });

  it('a code beats the words: a 22xxx-looking message with another SQLSTATE is not a data error', () => {
    expect(isDataError(prismaError('57014', 'invalid input syntax'))).toBe(false);
  });

  it('knows a missing relation and a lock timeout, by code and by words', () => {
    expect(isMissingRelation(prismaError('42P01'))).toBe(true);
    expect(isMissingRelation(new Error('relation "public.og_traffic_search" does not exist'))).toBe(true);
    expect(isMissingRelation(prismaError('22021'))).toBe(false);
    expect(isLockTimeout(prismaError('55P03'))).toBe(true);
    expect(isLockTimeout(new Error('canceling statement due to lock timeout'))).toBe(true);
    expect(isLockTimeout(prismaError('57014'))).toBe(false);
  });
});

describe('queryWithTimeout and withStatementTimeout', () => {
  const setup = (query: () => Promise<unknown>) => {
    const executed: string[] = [];
    const options: unknown[] = [];
    const tx = {
      $executeRawUnsafe: (sql: string) => {
        executed.push(sql);
        return Promise.resolve(0);
      },
      $queryRaw: query,
    };
    const prisma = {
      $transaction: (fn: (t: typeof tx) => Promise<unknown>, o: unknown) => {
        options.push(o);
        return fn(tx);
      },
    } as unknown as PrismaClient;
    return { prisma, executed, options };
  };

  it('sets the budget inside the transaction and gives the transaction room for all of it', async () => {
    const { prisma, executed, options } = setup(() => Promise.resolve([{ n: 1 }]));
    await expect(queryWithTimeout(prisma, Prisma.sql`SELECT 1`, 2500)).resolves.toEqual([{ n: 1 }]);
    expect(executed).toEqual(['SET LOCAL statement_timeout = 2500']);
    expect(options).toEqual([{ maxWait: 1000, timeout: 3500 }]);
  });

  it('truncates a fractional budget, so nothing but an integer reaches the SET', async () => {
    const { prisma, executed } = setup(() => Promise.resolve([]));
    await withStatementTimeout(prisma, 1500.9, () => Promise.resolve());
    expect(executed).toEqual(['SET LOCAL statement_timeout = 1500']);
  });

  it.each([
    ['a plain Error with the words', new Error('canceling statement due to statement timeout')],
    ['the code in the text', new Error('Raw query failed. Code: `57014`. Message: `x`')],
    // The branch the other two cannot reach: Prisma puts the SQLSTATE in meta and the message says nothing about it.
    ['only meta.code', prismaError('57014', 'Raw query failed')],
  ])('maps %s to SearchTimeoutError', async (_label, failure) => {
    const { prisma } = setup(() => Promise.reject(failure));
    await expect(queryWithTimeout(prisma, Prisma.sql`SELECT 1`, 100)).rejects.toBeInstanceOf(SearchTimeoutError);
  });

  it('lets any other failure through unchanged', async () => {
    const boom = new Error('connection refused');
    const { prisma } = setup(() => Promise.reject(boom));
    await expect(queryWithTimeout(prisma, Prisma.sql`SELECT 1`, 100)).rejects.toBe(boom);
    const other = prismaError('42P01');
    await expect(queryWithTimeout(setup(() => Promise.reject(other)).prisma, Prisma.sql`SELECT 1`, 100)).rejects.toBe(other);
  });
});
