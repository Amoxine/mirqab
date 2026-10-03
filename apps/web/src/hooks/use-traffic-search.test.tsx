// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { useTrafficSearch } from './use-traffic-search';

/**
 * A loaded infinite query refetches EVERY page, one after the other, once it is stale. Each page is a search the
 * server throttles (20 a minute) and allows two of at a time, so a window focus or a mount must not set that off,
 * and a search that is no longer wanted must be cancelled at the network rather than left to run.
 */

const page = (n: number) => ({
  range: '24h',
  items: [{ id: String(n), ts: `2026-10-03T10:00:0${String(n)}.000000Z`, apiId: null, apiName: null, method: 'GET', path: `/p/${String(n)}`, status: 200, latencyMs: 1, keyAlias: '', reqTruncated: false, resTruncated: false }],
  hasMore: n < 2,
  nextCursor: n < 2 ? { ts: `2026-10-03T10:00:0${String(n)}.000000Z`, id: String(n) } : null,
  indexedUntil: null,
});

interface Seen {
  body: Record<string, unknown>;
  signal: AbortSignal | undefined | null;
}
let seen: Seen[] = [];

beforeEach(() => {
  seen = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      seen.push({ body, signal: init?.signal });
      return Promise.resolve(new Response(JSON.stringify({ success: true, data: page('cursor' in body ? 2 : 1) }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useTrafficSearch('24h', []), { wrapper });
  return { client, wrapper, ...hook };
}
const loadBoth = async (hook: ReturnType<typeof setup>) => {
  await waitFor(() => {
    expect(hook.result.current.data?.pages).toHaveLength(1);
  });
  await act(async () => {
    await hook.result.current.fetchNextPage();
  });
  await waitFor(() => {
    expect(hook.result.current.data?.pages).toHaveLength(2);
  });
};

describe('useTrafficSearch', () => {
  it('hands the abort signal to the request, so a search that is no longer wanted is cancelled at the network', async () => {
    setup();
    await waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]?.signal?.aborted).toBe(false);
  });

  it('does not re-run every loaded page when the window gains focus, even long after they were loaded', async () => {
    const hook = setup();
    await loadBoth(hook);
    expect(seen).toHaveLength(2);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60 * 60_000);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(seen).toHaveLength(2);
  });

  it('does not re-run the pages when the hook mounts again shortly after they were loaded', async () => {
    const first = setup();
    await loadBoth(first);
    expect(seen).toHaveLength(2);
    // A second observer of the same search (a remount, another component) finds the pages fresh.
    renderHook(() => useTrafficSearch('24h', []), { wrapper: first.wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(seen).toHaveLength(2);
  });

  it('asks for the first page without a cursor and the next with the cursor the first returned', async () => {
    const hook = setup();
    await loadBoth(hook);
    expect('cursor' in (seen[0]?.body ?? {})).toBe(false);
    expect(seen[1]?.body.cursor).toEqual({ ts: '2026-10-03T10:00:01.000000Z', id: '1' });
  });
});
