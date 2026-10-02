// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSearchQuery } from './use-search-query';

/** `router.replace` calls, in order; the URL only changes when the test says the navigation has landed. */
const replace = vi.fn<(url: string, options?: unknown) => void>();
let url = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => '/analytics/search',
  useSearchParams: () => new URLSearchParams(url),
}));

/** The query string of the n-th `replace`. */
const written = (n: number) => String(replace.mock.calls[n]?.[0]).split('?')[1] ?? '';
const q = (n: number) => new URLSearchParams(written(n)).get('q');

function setup(start = '') {
  url = start;
  const hook = renderHook(() => useSearchQuery());
  /** Next applying the n-th navigation: the location changes and the page renders again. */
  const land = (n: number) => {
    url = written(n);
    hook.rerender();
  };
  return { ...hook, land };
}

beforeEach(() => {
  replace.mockClear();
});

describe('useSearchQuery: entries made faster than the URL changes', () => {
  it('keeps every chip of three quick entries: each builds on the one before, not on the URL it has not caught up with', () => {
    const { result } = setup();
    act(() => {
      result.current.add('status:>=500');
      result.current.add('-method:GET');
      result.current.add('latency:>500');
    });
    expect(q(0)).toBe('status:>=500');
    expect(q(1)).toBe('status:>=500 -method:GET');
    expect(q(2)).toBe('status:>=500 -method:GET latency:>500');
  });

  it('converges: once the navigations land in turn, the chips are the three that were entered', () => {
    const { result, land } = setup();
    act(() => {
      result.current.add('status:>=500');
      result.current.add('-method:GET');
      result.current.add('latency:>500');
    });
    land(0);
    land(1);
    land(2);
    expect(result.current.tokens.map((t) => t.text)).toEqual(['status:>=500', '-method:GET', 'latency:>500']);
  });

  it('keeps the entries a navigation never delivered: the next write carries them too', () => {
    const { result } = setup();
    act(() => {
      result.current.add('status:>=500');
    });
    // The URL never changes (the navigation failed); the person enters another filter.
    act(() => {
      result.current.add('method:POST');
    });
    expect(q(1)).toBe('status:>=500 method:POST');
  });

  it('removes a chip by what it says even while an earlier entry is in flight (the chips shown are the older ones)', () => {
    const { result, land } = setup('q=status%3A500');
    act(() => {
      result.current.add('method:POST');
    });
    // Chip 0 of what is shown is still `status:500`.
    act(() => {
      result.current.remove(0);
    });
    expect(q(1)).toBe('method:POST');
    land(0);
    land(1);
    expect(result.current.tokens.map((t) => t.text)).toEqual(['method:POST']);
  });

  it('removing a chip that an earlier write already removed changes nothing', () => {
    const { result } = setup('q=status%3A500+method%3APOST');
    act(() => {
      result.current.remove(0);
      result.current.remove(0);
    });
    expect(q(0)).toBe('method:POST');
    expect(q(1)).toBe('method:POST');
  });

  it('keeps the range a quick range change set, for the entry after it', () => {
    const { result } = setup();
    act(() => {
      result.current.add('status:500');
      result.current.setRange('7d');
      result.current.add('method:GET');
    });
    expect(new URLSearchParams(written(2)).get('range')).toBe('7d');
    expect(q(2)).toBe('status:500 method:GET');
  });

  it('replaceAll takes the text as the new search and keeps what it does not own', () => {
    const { result } = setup('q=status%3A500&range=7d');
    act(() => {
      result.current.replaceAll('path:/orders');
    });
    expect(q(0)).toBe('path:/orders');
    expect(new URLSearchParams(written(0)).get('range')).toBe('7d');
  });
});

describe('useSearchQuery: after the URL has caught up', () => {
  it('builds on the real URL again, so a change someone else made to it is not undone', () => {
    const { result, land, rerender } = setup();
    act(() => {
      result.current.add('status:500');
    });
    land(0);
    // Another writer (the open request, a range control) changes the URL after that.
    url = 'q=status%3A500&req=9&ts=2026-09-29T10%3A00%3A01Z';
    rerender();
    act(() => {
      result.current.add('method:GET');
    });
    expect(new URLSearchParams(written(1)).get('req')).toBe('9');
    expect(q(1)).toBe('status:500 method:GET');
  });
});
