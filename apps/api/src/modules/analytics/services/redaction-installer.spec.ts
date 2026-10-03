import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { TAG_PENDING } from '../search/traffic-search.state';
import { analyticsRedactionDdl } from './pump-query.builder';
import { BACKFILL_BATCH_ROWS, backfillWindows, ensureRedaction, inBatches, installedTag, redactionTag } from './redaction-installer';

describe('redactionTag', () => {
  it('is stable for the same rules and changes with the field list', () => {
    expect(redactionTag(['password', 'token'])).toBe(redactionTag(['password', 'token']));
    expect(redactionTag(['password', 'token'])).not.toBe(redactionTag(['password']));
    expect(redactionTag(['password'])).toMatch(/^ddl:[0-9a-f]{16}$/);
  });
});

describe('backfillWindows', () => {
  const t = (iso: string) => new Date(iso);

  it('covers [from, to) newest first in steps, with a shorter last window', () => {
    const w = backfillWindows(t('2026-09-29T10:00:00Z'), t('2026-09-29T10:25:00Z'), 10 * 60_000);
    expect(w.map(([a, b]) => [a.toISOString(), b.toISOString()])).toEqual([
      ['2026-09-29T10:15:00.000Z', '2026-09-29T10:25:00.000Z'],
      ['2026-09-29T10:05:00.000Z', '2026-09-29T10:15:00.000Z'],
      ['2026-09-29T10:00:00.000Z', '2026-09-29T10:05:00.000Z'],
    ]);
  });

  it('leaves no gap and no overlap, whatever the step', () => {
    const from = t('2026-09-01T00:00:07Z');
    const to = t('2026-09-03T05:13:00Z');
    const w = backfillWindows(from, to, 37 * 60_000);
    expect(w[0]?.[1].getTime()).toBe(to.getTime());
    expect(w.at(-1)?.[0].getTime()).toBe(from.getTime());
    for (let i = 1; i < w.length; i++) expect(w[i]?.[1].getTime()).toBe(w[i - 1]?.[0].getTime());
  });

  it('is empty when there is nothing to cover', () => {
    expect(backfillWindows(t('2026-09-29T10:00:00Z'), t('2026-09-29T10:00:00Z'))).toEqual([]);
  });
});

describe('inBatches', () => {
  it('slices in order, keeps the remainder, and gives nothing for nothing', () => {
    expect(inBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(inBatches([1, 2], 5)).toEqual([[1, 2]]);
    expect(inBatches([], 3)).toEqual([]);
  });
});

const textOf = (q: unknown): string => (Array.isArray(q) ? (q as string[]).join('?') : String(q));
const FIELDS = ['password', 'token'];
const TAG = redactionTag(FIELDS);

interface Script {
  /** What the version read answers on each call: a row, or an Error. */
  versions: ({ present: boolean; tag: string | null } | Error)[];
  ids: string[];
  ddlErrors: Error[];
  oldest: Date | null;
}

function setup(over: Partial<Script> = {}) {
  const script: Script = { versions: [{ present: true, tag: 'ddl:old' }, { present: true, tag: 'ddl:old' }], ids: [], ddlErrors: [], oldest: null, ...over };
  const calls = { ddl: 0, updates: [] as { text: string; ids: string[] }[], unsafe: [] as string[], order: [] as string[] };
  const versionRead = (): Promise<unknown[]> => {
    const next = script.versions.shift() ?? { present: true, tag: TAG };
    return next instanceof Error ? Promise.reject(next) : Promise.resolve([next]);
  };
  const tx: Record<string, unknown> = {};
  const prisma = {
    $queryRawUnsafe: () => {
      calls.ddl += 1;
      calls.order.push('ddl');
      const err = script.ddlErrors.shift();
      return err ? Promise.reject(err) : Promise.resolve([]);
    },
    $queryRaw: (strings: TemplateStringsArray) => {
      const text = textOf(strings);
      if (text.includes('to_regprocedure')) return versionRead();
      if (text.includes('min("timestamp")')) return Promise.resolve([{ ts: script.oldest }]);
      if (text.includes('SELECT ctid::text AS id')) return Promise.resolve(script.ids.map((id) => ({ id })));
      if (text.includes('to_regclass(\'public.og_traffic_search_state\')')) return Promise.resolve([{ state: true, rows: true }]);
      return Promise.reject(new Error(`unscripted query: ${text}`));
    },
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = textOf(strings);
      if (text.includes('UPDATE public.tyk_analytics')) {
        calls.updates.push({ text, ids: values[2] as string[] });
        calls.order.push('update');
        return Promise.resolve(1);
      }
      if (text.includes('generation = s.generation + 1')) {
        calls.order.push(`reset:${String(values[1])}`);
        return Promise.resolve(1);
      }
      return Promise.reject(new Error(`unscripted execute: ${text}`));
    },
    $executeRawUnsafe: (sql: string) => {
      calls.unsafe.push(sql);
      calls.order.push(sql.startsWith('COMMENT') ? 'tag' : sql.startsWith('TRUNCATE') ? 'truncate' : 'other');
      return Promise.resolve(0);
    },
    $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(prisma),
  };
  Object.assign(tx, prisma);
  return { prisma: prisma as unknown as PrismaClient, script, calls };
}

describe('installedTag', () => {
  it('says absent only when the function is absent, and throws when the read fails', async () => {
    const absent = setup({ versions: [{ present: false, tag: null }] });
    await expect(installedTag(absent.prisma)).resolves.toEqual({ present: false, tag: null });
    const failing = setup({ versions: [new Error('connection reset')] });
    await expect(installedTag(failing.prisma)).rejects.toThrow('connection reset');
  });
});

describe('ensureRedaction', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('records the version on a first install and rewrites nothing', async () => {
    const { prisma, calls } = setup({ versions: [{ present: false, tag: null }, { present: true, tag: null }] });
    const install = await ensureRedaction(prisma, FIELDS, 30);
    expect(install.upgrading).toBe(false);
    expect(calls.unsafe).toEqual([`COMMENT ON FUNCTION public.og_redact_http_dump(text,text) IS '${TAG}'`]);
    expect(calls.updates).toHaveLength(0);
  });

  it('does nothing more when the installed rules are already current', async () => {
    const { prisma, calls } = setup({ versions: [{ present: true, tag: TAG }, { present: true, tag: TAG }] });
    expect((await ensureRedaction(prisma, FIELDS, 30)).upgrading).toBe(false);
    expect(calls.unsafe).toEqual([]);
  });

  it('an unreadable version still installs the trigger, then fails the call without writing a tag (it is not a first install)', async () => {
    const { prisma, calls } = setup({ versions: [new Error('connection reset')] });
    await expect(ensureRedaction(prisma, FIELDS, 30)).rejects.toThrow('connection reset');
    expect(calls.ddl).toBe(1);
    expect(calls.unsafe).toEqual([]);
  });

  it('retries a trigger lock the pump held, a few seconds apart, and gives up after three tries', async () => {
    jest.useFakeTimers();
    const lock = (): Error => Object.assign(new Error('lock timeout'), { meta: { code: '55P03' } });
    const ok = setup({ versions: [{ present: true, tag: TAG }, { present: true, tag: TAG }], ddlErrors: [lock(), lock()] });
    const done = ensureRedaction(ok.prisma, FIELDS, 30);
    await jest.advanceTimersByTimeAsync(4500);
    await expect(done).resolves.toMatchObject({ upgrading: false });
    expect(ok.calls.ddl).toBe(3);

    const stuck = setup({ ddlErrors: [lock(), lock(), lock()] });
    const failed = ensureRedaction(stuck.prisma, FIELDS, 30).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(4500);
    expect(await failed).toBeInstanceOf(Error);
    expect(stuck.calls.ddl).toBe(3);
  });

  it('does not retry an error that is not a lock', async () => {
    const { prisma, calls } = setup({ ddlErrors: [new Error('permission denied')] });
    await expect(ensureRedaction(prisma, FIELDS, 30)).rejects.toThrow('permission denied');
    expect(calls.ddl).toBe(1);
  });

  describe('a rules change', () => {
    const NOW = new Date('2026-09-29T12:00:00.000Z');
    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `(0,${String(i + 1)})`);

    it('rewrites only what the function changes, in batches of rows, then empties the projection, and writes the tag LAST', async () => {
      const { prisma, calls } = setup({ ids: ids(BACKFILL_BATCH_ROWS * 2 + 50), oldest: new Date(NOW.getTime() - 60_000) });
      const install = await ensureRedaction(prisma, FIELDS, 30, NOW);
      expect(install.upgrading).toBe(true);
      await install.done;

      expect(calls.updates.map((u) => u.ids.length)).toEqual([BACKFILL_BATCH_ROWS, BACKFILL_BATCH_ROWS, 50]);
      for (const u of calls.updates) {
        expect(u.text).toContain('IS DISTINCT FROM'); // an unchanged row is not rewritten
        expect(u.text).toContain('ctid = ANY(');
      }
      // Every rewrite, then the projection reset (under the installer's pending tag), then the version.
      const order = calls.order;
      expect(order.indexOf('tag')).toBe(order.length - 1);
      expect(order.indexOf(`reset:${TAG_PENDING}`)).toBeGreaterThan(order.lastIndexOf('update'));
      expect(order.indexOf('tag')).toBeGreaterThan(order.indexOf(`reset:${TAG_PENDING}`));
    });

    it('leaves the old tag in place when the backfill fails, so the next boot tries again', async () => {
      const { prisma, calls } = setup({ ids: ids(3), oldest: new Date(NOW.getTime() - 60_000) });
      const originalExecute = (prisma as unknown as { $executeRaw: (...a: unknown[]) => Promise<number> }).$executeRaw;
      (prisma as unknown as { $executeRaw: unknown }).$executeRaw = (...args: unknown[]) =>
        textOf(args[0]).includes('UPDATE public.tyk_analytics') ? Promise.reject(new Error('deadlock detected')) : originalExecute(...args);
      const install = await ensureRedaction(prisma, FIELDS, 30, NOW);
      await install.done;
      expect(calls.unsafe.some((sql) => sql.startsWith('COMMENT'))).toBe(false);
    });

    it('with no captured rows there is nothing to rewrite, but the projection is still reset and the tag written', async () => {
      const { prisma, calls } = setup({ oldest: null });
      await (await ensureRedaction(prisma, FIELDS, 30, NOW)).done;
      expect(calls.updates).toHaveLength(0);
      expect(calls.order).toContain(`reset:${TAG_PENDING}`);
      expect(calls.order.at(-1)).toBe('tag');
    });
  });

  it('installs the DDL of the fields it was given', () => {
    expect(analyticsRedactionDdl(FIELDS)).toContain('password|token');
  });
});
