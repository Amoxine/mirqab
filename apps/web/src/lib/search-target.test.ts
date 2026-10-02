import { describe, expect, it } from 'vitest';
import { parseSearchTarget, searchRequestKey, withSearchTarget } from './search-target';

const TS = '2026-09-29T10:00:01.123456Z';
const params = (query: string) => new URLSearchParams(query);

describe('parseSearchTarget', () => {
  it('reads the request a shared link points at: its id and its own timestamp', () => {
    expect(parseSearchTarget(params(`req=42&ts=${encodeURIComponent(TS)}`))).toEqual({ id: '42', ts: TS });
  });

  it('needs both: the detail endpoint cannot find a request by its id alone', () => {
    expect(parseSearchTarget(params('req=42'))).toBeNull();
    expect(parseSearchTarget(params(`ts=${encodeURIComponent(TS)}`))).toBeNull();
    expect(parseSearchTarget(params(''))).toBeNull();
  });

  it.each([
    ['a path-like id', '../../auth/me'],
    ['an id with letters', '12ab'],
    ['an empty id', ''],
    ['a negative id', '-1'],
    ['an id too long for a bigint', '1'.repeat(25)],
  ])('ignores %s, so a crafted link cannot steer the request somewhere else', (_name, id) => {
    expect(parseSearchTarget(params(`req=${encodeURIComponent(id)}&ts=${encodeURIComponent(TS)}`))).toBeNull();
  });

  it.each([
    ['not a timestamp', 'yesterday'],
    ['a date without a time', '2026-09-29'],
    ['a timestamp with an offset instead of Z', '2026-09-29T10:00:01.123456+02:00'],
    ['a timestamp with trailing text', `${TS}&x=1`],
  ])('ignores %s', (_name, ts) => {
    expect(parseSearchTarget(params(`req=42&ts=${encodeURIComponent(ts)}`))).toBeNull();
  });

  it('accepts a timestamp with or without fractional seconds', () => {
    expect(parseSearchTarget(params('req=1&ts=2026-09-29T10:00:01Z'))?.ts).toBe('2026-09-29T10:00:01Z');
    expect(parseSearchTarget(params('req=1&ts=2026-09-29T10:00:01.5Z'))?.ts).toBe('2026-09-29T10:00:01.5Z');
  });
});

describe('withSearchTarget', () => {
  it('adds the request to the URL and keeps everything else (the search and the range)', () => {
    const next = withSearchTarget(params('q=status%3A500&range=7d'), { id: '42', ts: TS });
    expect(next.get('q')).toBe('status:500');
    expect(next.get('range')).toBe('7d');
    expect(next.get('req')).toBe('42');
    expect(next.get('ts')).toBe(TS);
  });

  it('replaces the request already there', () => {
    const next = withSearchTarget(params('req=1&ts=2026-09-29T10:00:00Z&q=a'), { id: '2', ts: TS });
    expect(next.getAll('req')).toEqual(['2']);
    expect(next.getAll('ts')).toEqual([TS]);
  });

  it('removes the request and keeps the rest when given null', () => {
    const next = withSearchTarget(params(`q=status%3A500&req=42&ts=${encodeURIComponent(TS)}`), null);
    expect(next.toString()).toBe('q=status%3A500');
  });

  it('does not change the params it was given', () => {
    const original = params('q=a');
    withSearchTarget(original, { id: '1', ts: TS });
    expect(original.toString()).toBe('q=a');
  });
});

describe('searchRequestKey', () => {
  it('names a request by its id and its own timestamp, which together are unique', () => {
    expect(searchRequestKey({ id: '42', ts: TS })).toBe(`search:42@${TS}`);
    expect(searchRequestKey({ id: '42', ts: TS })).not.toBe(searchRequestKey({ id: '42', ts: '2026-09-30T00:00:00Z' }));
  });
});
