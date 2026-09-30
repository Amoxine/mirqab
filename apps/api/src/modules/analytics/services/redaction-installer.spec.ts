import { backfillWindows, redactionTag } from './redaction-installer';

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
