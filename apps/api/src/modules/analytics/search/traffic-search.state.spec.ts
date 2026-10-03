import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import * as parser from '../services/http-dump-parser';
import {
  changedAuthHeaders,
  commitProgress,
  projectionTag,
  PROJECTION_RULES_VERSION,
  readState,
  resetProjection,
  TAG_PENDING,
} from './traffic-search.state';

const textOf = (q: unknown): string => (Array.isArray(q) ? (q as string[]).join('?') : (q as { text: string }).text);

describe('projectionTag', () => {
  it('is a stable fingerprint of everything that decides what a stored row holds', () => {
    expect(projectionTag('ddl:abc')).toBe(projectionTag('ddl:abc'));
    expect(projectionTag('ddl:abc')).toMatch(/^proj:[0-9a-f]{16}$/);
    const expected = createHash('sha256')
      .update(['ddl:abc', parser.parserRulesFingerprint(), String(PROJECTION_RULES_VERSION)].join('\u0000'))
      .digest('hex')
      .slice(0, 16);
    expect(projectionTag('ddl:abc')).toBe(`proj:${expected}`);
  });

  it('changes with the SQL redaction rules', () => {
    expect(projectionTag('ddl:abc')).not.toBe(projectionTag('ddl:def'));
    expect(projectionTag(null)).not.toBe(projectionTag('ddl:abc'));
  });

  it('changes when a parser rule changes, so rows stored under the old rule are rebuilt', () => {
    const before = projectionTag('ddl:abc');
    const spy = jest.spyOn(parser, 'parserRulesFingerprint').mockReturnValue('a-rule-was-edited');
    try {
      expect(projectionTag('ddl:abc')).not.toBe(before);
    } finally {
      spy.mockRestore();
    }
    expect(projectionTag('ddl:abc')).toBe(before);
  });
});

describe('changedAuthHeaders', () => {
  const current = (entries: [string, string | null][]): Map<string, string | null> => new Map(entries);

  it('reports an existing API whose header was renamed, removed or newly set', () => {
    expect(changedAuthHeaders({ a: 'X-Old' }, current([['a', 'X-New']]))).toEqual(['a']);
    expect(changedAuthHeaders({ a: 'X-Old' }, current([['a', null]]))).toEqual(['a']);
    expect(changedAuthHeaders({ a: null }, current([['a', 'X-Tenant']]))).toEqual(['a']);
  });

  it('ignores a new API (no old rows to fix), a deleted one, and a header that only changed case', () => {
    expect(changedAuthHeaders({ a: 'X-A' }, current([['a', 'X-A'], ['b', 'X-B']]))).toEqual([]);
    expect(changedAuthHeaders({ a: 'X-A', gone: 'X-G' }, current([['a', 'X-A']]))).toEqual([]);
    expect(changedAuthHeaders({ a: 'X-Tenant' }, current([['a', 'x-tenant']]))).toEqual([]);
  });

  it('knows nothing of an empty state: the first tick records the headers instead of rebuilding', () => {
    expect(changedAuthHeaders({}, current([['a', 'X-A']]))).toEqual([]);
  });
});

describe('readState', () => {
  const db = (rows: unknown[] | Error) => ({ $queryRaw: () => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)) }) as unknown as Pick<PrismaClient, '$queryRaw'>;

  it('is null when there is no row, and a row\'s columns otherwise (the generation as a number)', async () => {
    expect(await readState(db([]))).toBeNull();
    const until = new Date('2026-09-29T11:00:00Z');
    const from = new Date('2026-09-22T11:00:00Z');
    expect(
      await readState(db([{ scanned_until: until, indexed_from: from, generation: 5n, redaction_tag: 'proj:x', auth_headers: { a: 'X-A' } }])),
    ).toEqual({ scannedUntil: until, indexedFrom: from, generation: 5, redactionTag: 'proj:x', authHeaders: { a: 'X-A' } });
  });

  it('throws on a failed read: that is not "no row"', async () => {
    await expect(readState(db(new Error('connection reset')))).rejects.toThrow('connection reset');
  });
});

describe('commitProgress', () => {
  const run = async (changed: number) => {
    const seen: { text: string; values: unknown[] }[] = [];
    const db = {
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        seen.push({ text: textOf(strings), values });
        return Promise.resolve(changed);
      },
    } as unknown as Pick<PrismaClient, '$executeRaw'>;
    const ok = await commitProgress(db, {
      from: new Date('2026-09-22T12:00:00Z'),
      until: '2026-09-29T11:59:59.123456Z',
      generation: 3,
      tag: 'proj:x',
      authHeaders: new Map([['tyk-a', 'X-A']]),
    });
    return { ok, sql: seen.at(0) };
  };

  it('writes only while the generation is the one the scan started under, and says whether it did', async () => {
    const applied = await run(1);
    expect(applied.ok).toBe(true);
    expect(applied.sql?.text).toContain('WHERE s.generation = EXCLUDED.generation');
    expect((await run(0)).ok).toBe(false);
  });

  it('keeps the microseconds of the instant it reached, never moves the watermark back, and only ever lowers indexed_from', async () => {
    const { sql } = await run(1);
    expect(sql?.values[0]).toBe('2026-09-29T11:59:59.123456Z');
    expect(sql?.text).toContain('GREATEST(s.scanned_until, EXCLUDED.scanned_until)');
    expect(sql?.text).toContain('LEAST(s.indexed_from, EXCLUDED.indexed_from)');
    expect(sql?.values[2]).toBe(3);
    expect(JSON.parse(sql?.values[4] as string)).toEqual({ 'tyk-a': 'X-A' });
  });
});

describe('resetProjection', () => {
  const setup = (present: { state: boolean; rows: boolean }) => {
    const executed: string[] = [];
    const upserts: unknown[][] = [];
    const tx = {
      $queryRaw: () => Promise.resolve([present]),
      $executeRawUnsafe: (sql: string) => {
        executed.push(sql);
        return Promise.resolve(0);
      },
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        executed.push(textOf(strings));
        upserts.push(values);
        return Promise.resolve(1);
      },
    };
    const prisma = { $transaction: (fn: (t: typeof tx) => Promise<void>) => fn(tx) } as unknown as PrismaClient;
    return { prisma, executed, upserts };
  };

  it('empties the table and raises the generation in ONE transaction, with the rebuild starting at the retention floor', async () => {
    const { prisma, executed, upserts } = setup({ state: true, rows: true });
    await resetProjection(prisma, 30, TAG_PENDING, new Map([['a', 'X-A']]));

    expect(executed[0]).toBe(`SET LOCAL lock_timeout = '10s'`);
    expect(executed[1]).toBe('TRUNCATE public.og_traffic_search');
    expect(executed[2]).toContain('generation = s.generation + 1');
    expect(executed[2]).toContain('indexed_from = NULL');
    expect(executed[2]).toContain('now() - make_interval(days =>');
    expect(upserts[0]).toEqual([30, TAG_PENDING, '{"a":"X-A"}']);
  });

  it('does nothing before the search tables exist: no scan has run, so nothing derived needs clearing', async () => {
    const { prisma, executed } = setup({ state: false, rows: false });
    await resetProjection(prisma, 30, 'proj:x');
    expect(executed).toEqual([]);
  });

  it('still records the state when only the table is missing (nothing to truncate)', async () => {
    const { prisma, executed } = setup({ state: true, rows: false });
    await resetProjection(prisma, 30, 'proj:x');
    expect(executed.some((q) => q.startsWith('TRUNCATE'))).toBe(false);
    expect(executed.some((q) => q.includes('generation = s.generation + 1'))).toBe(true);
  });
});
