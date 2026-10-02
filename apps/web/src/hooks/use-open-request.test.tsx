// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { TrafficSearchItem } from '@/hooks/use-traffic-search';
import { tokenize } from '@/lib/traffic-search';
import { useOpenRequest } from './use-open-request';

const replace = vi.fn();
let url = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => '/analytics/search',
  useSearchParams: () => new URLSearchParams(url),
}));

const TS = '2026-09-29T10:00:01.123456Z';
const item = (id: string): TrafficSearchItem => ({
  id,
  ts: TS,
  apiId: null,
  apiName: null,
  method: 'GET',
  path: `/orders/${id}`,
  status: 500,
  latencyMs: 10,
  keyAlias: '',
  reqTruncated: false,
  resTruncated: false,
});
const ITEMS = [item('1'), item('2')];

/** The URL with request 1 open and `q` as the search, the way Next would give it back. */
const urlFor = (q: string, open: boolean | string = true) =>
  new URLSearchParams({ ...(q ? { q } : {}), ...(open ? { req: typeof open === 'string' ? open : '1', ts: TS } : {}) }).toString();

/** The hook with a stand-in for the search bar's `replaceAll`, which is what writes the new search into the URL. */
function setup(q = 'status:500') {
  url = urlFor(q);
  const replaceAll = vi.fn<(text: string) => void>();
  const hook = renderHook(
    ({ q: current }) => useOpenRequest(ITEMS, { tokens: tokenize(current).map((text) => ({ text })), replaceAll }),
    { initialProps: { q } },
  );
  /** Next applying a URL: the mocked location changes and the page renders with the new search. */
  const land = (next: string, open: boolean | string = true) => {
    url = urlFor(next, open);
    hook.rerender({ q: next });
  };
  return { ...hook, replaceAll, land };
}
const lastUrl = () => String(replace.mock.calls.at(-1)?.[0]);

beforeEach(() => {
  replace.mockClear();
});

describe('useOpenRequest: adding a filter from the open request', () => {
  it('adds the filter to the search the bar already holds', () => {
    const { result, replaceAll } = setup('status:500');
    act(() => {
      result.current.addFilter('path:/orders/1');
    });
    expect(replaceAll).toHaveBeenCalledWith('status:500 path:/orders/1');
  });

  it('closes the sheet only once the new search has reached the URL, and only then', () => {
    const { result, land } = setup('status:500');
    act(() => {
      result.current.addFilter('path:/orders/1');
    });
    expect(replace).not.toHaveBeenCalled();
    land('status:500 path:/orders/1');
    expect(replace).toHaveBeenCalledTimes(1);
    // From the NEW url: the search it just wrote is kept, the request is taken out.
    const next = new URLSearchParams(lastUrl().split('?')[1]);
    expect(Object.fromEntries(next)).toEqual({ q: 'status:500 path:/orders/1' });
  });

  it('lets two filters added in quick succession both land: the second builds on the first, not on the stale search', () => {
    const { result, replaceAll } = setup('status:500');
    act(() => {
      result.current.addFilter('path:/orders/1');
      // No render has happened in between, so the search bar still reports only `status:500`.
      result.current.addFilter('method:GET');
    });
    expect(replaceAll).toHaveBeenNthCalledWith(1, 'status:500 path:/orders/1');
    expect(replaceAll).toHaveBeenNthCalledWith(2, 'status:500 path:/orders/1 method:GET');
  });

  it('closes after the LAST of those quick filters lands, not after the first', () => {
    const { result, land } = setup('status:500');
    act(() => {
      result.current.addFilter('path:/orders/1');
      result.current.addFilter('method:GET');
    });
    land('status:500 path:/orders/1');
    expect(replace).not.toHaveBeenCalled();
    land('status:500 path:/orders/1 method:GET');
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a filter the search already holds, and arms nothing: a later change does not close the sheet', () => {
    const { result, replaceAll, land } = setup('status:500');
    act(() => {
      result.current.addFilter('status:500');
    });
    expect(replaceAll).not.toHaveBeenCalled();
    land('method:POST');
    land('method:POST path:/other');
    expect(replace).not.toHaveBeenCalled();
  });

  it('closes once: a later search change is not followed by another close', () => {
    const { result, land } = setup('status:500');
    act(() => {
      result.current.addFilter('path:/orders/1');
    });
    land('status:500 path:/orders/1');
    expect(replace).toHaveBeenCalledTimes(1);
    land('status:500 path:/orders/1 method:GET');
    land('method:GET');
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('does not close a request opened afterwards, even when the search is the one it once waited for', () => {
    const { result, land } = setup('status:500');
    act(() => {
      result.current.addFilter('path:/orders/1');
    });
    land('status:500 path:/orders/1');
    expect(replace).toHaveBeenCalledTimes(1);
    // The sheet is gone; the person opens a request again, on the same search.
    land('status:500 path:/orders/1', false);
    land('status:500 path:/orders/1', true);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('does not close again when the person steps to another request on the search it already closed for', () => {
    const { result, land } = setup('status:500');
    act(() => {
      result.current.addFilter('path:/orders/1');
    });
    land('status:500 path:/orders/1');
    expect(replace).toHaveBeenCalledTimes(1);
    // The close has not been applied yet (the sheet is still open), and the person steps to request 2.
    land('status:500 path:/orders/1', '2');
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('does not close on a search change that is not the one it is waiting for', () => {
    const { result, land } = setup('status:500');
    act(() => {
      result.current.addFilter('path:/orders/1');
    });
    land('method:POST');
    expect(replace).not.toHaveBeenCalled();
  });

  it('forgets what it was waiting for when the sheet is closed another way, so a late landing does not close a later one', () => {
    const { result, land } = setup('status:500');
    act(() => {
      result.current.addFilter('path:/orders/1');
    });
    // The person closes the sheet (the URL loses the request) before the search has landed...
    land('status:500', false);
    // ...then opens another request, and the earlier search lands afterwards.
    land('status:500 path:/orders/1', true);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('useOpenRequest: opening, stepping and closing', () => {
  it('reads the open request from the URL and finds its neighbours among the loaded results', () => {
    const { result } = setup('');
    expect(result.current.target).toEqual({ id: '1', ts: TS });
    expect(result.current.listItem?.id).toBe('1');
    expect(result.current.previous).toBeUndefined();
    expect(result.current.next?.id).toBe('2');
    expect(result.current.position).toEqual({ index: 1, count: 2 });
  });

  it('writes a request into the URL by replacing the entry and keeping the scroll, and keeps the search', () => {
    const { result } = setup('status:500');
    act(() => {
      result.current.open(item('2'));
    });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0]?.[1]).toEqual({ scroll: false });
    expect(Object.fromEntries(new URLSearchParams(lastUrl().split('?')[1]))).toEqual({ q: 'status:500', req: '2', ts: TS });
  });

  it('takes only the request out of the URL when closing', () => {
    const { result } = setup('status:500');
    act(() => {
      result.current.close();
    });
    expect(lastUrl()).toBe(`/analytics/search?${new URLSearchParams({ q: 'status:500' }).toString()}`);
  });
});
