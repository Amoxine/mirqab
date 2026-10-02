// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import analytics from '@/messages/en/analytics.json';
import apis from '@/messages/en/apis.json';
import auth from '@/messages/en/auth.json';
import common from '@/messages/en/common.json';
import dashboard from '@/messages/en/dashboard.json';
import { fail, mockFetch, never, ok } from '@/components/apis/endpoints/test-utils';
import TrafficSearchPage from './page';

const replace = vi.fn();
let search = '';
let granted: string[] = ['analytics:read', 'api:update'];
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => '/analytics/search',
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));

const T = analytics.search;
/** The error text sits beside the chip's <code>, so match it as a fragment of its paragraph. */
const fragment = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const WAIT = { timeout: 8000 };
/**
 * One turn of the event loop inside `act`: everything already queued (effects, query starts, the mocked
 * fetch's microtasks) has run when it returns. A negative assertion made after it is about what the
 * page DID, not about how long we waited; the mutation that makes the page fetch anyway fails it.
 */
const settled = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

function renderPage(node: ReactNode = <TrafficSearchPage />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={{ analytics, apis, auth, common, dashboard }}>
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const item = (n: number, over: Partial<Record<string, unknown>> = {}) => ({
  id: String(n),
  ts: `2026-09-29T10:00:0${String(n % 10)}.123456Z`,
  apiId: 'def-1',
  apiName: 'Orders API',
  method: 'POST',
  path: `/orders/${String(n)}`,
  status: 500,
  latencyMs: 340,
  keyAlias: 'qbus-web',
  reqTruncated: false,
  resTruncated: false,
  ...over,
});
const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  range: '24h',
  items,
  hasMore: false,
  nextCursor: null,
  indexedUntil: '2026-09-29T11:59:50.000Z',
  ...extra,
});
const searchBodies = (calls: { path: string; body: string | undefined }[]) =>
  calls.filter((c) => c.path === '/analytics/traffic/search').map((c) => JSON.parse(c.body ?? '{}') as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  search = '';
  granted = ['analytics:read', 'api:update'];
});

describe('traffic search page', () => {
  it('turns the ?q text into chips and sends exactly the parsed clauses', async () => {
    search = 'q=status%3A%3E%3D500+method%3Apost&range=7d';
    const calls = mockFetch(() => ok(page([item(1)])));
    renderPage();

    expect(await screen.findByRole('button', { name: 'Edit filter status:>=500' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Edit filter method:post' })).toBeDefined();
    await screen.findByText('/orders/1', undefined, WAIT);

    expect(searchBodies(calls)[0]).toEqual({
      range: '7d',
      limit: 50,
      clauses: [
        { kind: 'status', neg: false, match: { type: 'cmp', op: '>=', value: 500 } },
        { kind: 'method', neg: false, values: ['POST'] },
      ],
    });
  });

  it('writes a typed filter into the URL on Enter, and drops the default range', async () => {
    mockFetch(() => ok(page([])));
    renderPage();
    const input = await screen.findByLabelText(T.inputLabel);
    fireEvent.change(input, { target: { value: 'latency:>800' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(replace).toHaveBeenCalledWith('/analytics/search?q=latency%3A%3E800', { scroll: false });
  });

  it('removes a chip from the URL', async () => {
    search = 'q=status%3A500+method%3APOST';
    mockFetch(() => ok(page([])));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove filter status:500' }));
    expect(replace).toHaveBeenCalledWith('/analytics/search?q=method%3APOST', { scroll: false });
  });

  it('shows why a filter was not understood, in words, and does not search', async () => {
    search = 'q=status%3A99+body%3Aid';
    const calls = mockFetch(() => ok(page([])));
    renderPage();
    await screen.findByText(fragment(T.errors.status));
    expect(screen.getByText(fragment(T.errors.termTooShort.replace('{min}', '3')))).toBeDefined();
    expect(screen.getByRole('button', { name: 'Edit filter status:99' })).toBeDefined();
    await settled();
    expect(searchBodies(calls)).toHaveLength(0);
  });

  it('refuses a common word with its own message', async () => {
    search = 'q=data';
    mockFetch(() => ok(page([])));
    renderPage();
    expect(await screen.findByText(fragment(T.errors.commonWord.replace('{term}', 'data')))).toBeDefined();
  });

  it('refuses more than 3 body-word filters before searching', async () => {
    search = 'q=' + encodeURIComponent('timeout refused upstream gateway');
    const calls = mockFetch(() => ok(page([])));
    renderPage();
    await screen.findByText(T.errors.tooManyBodyClauses);
    expect(searchBodies(calls)).toHaveLength(0);
  });

  it('lists results with status, latency and the cut-at-16-KiB badge, and pages with the cursor', async () => {
    const first = page([item(1), item(2, { resTruncated: true, status: 402 })], { hasMore: true, nextCursor: { ts: '2026-09-29T10:00:02.123456Z', id: '2' } });
    const second = page([item(3)]);
    const calls = mockFetch((c) => ok(c.body?.includes('"cursor"') ? second : first));
    renderPage();

    await screen.findByText('/orders/1', undefined, WAIT);
    expect(screen.getByText('/orders/2')).toBeDefined();
    expect(screen.getAllByText(T.truncatedBadge)).toHaveLength(1);
    expect(screen.getByText('402')).toBeDefined();
    expect(screen.getByText(/Indexed up to/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: T.loadMore }));
    await screen.findByText('/orders/3', undefined, WAIT);
    expect(screen.getByText('/orders/1')).toBeDefined(); // the first page stays
    expect(searchBodies(calls)[1]).toMatchObject({ cursor: { ts: '2026-09-29T10:00:02.123456Z', id: '2' } });
    expect(screen.queryByRole('button', { name: T.loadMore })).toBeNull(); // last page
  });

  it('says what an empty result means: nothing captured vs nothing matching', async () => {
    mockFetch(() => ok(page([])));
    const { unmount } = renderPage();
    expect(await screen.findByText(T.emptyNoCapture, undefined, WAIT)).toBeDefined();
    unmount();

    search = 'q=status%3A500';
    mockFetch(() => ok(page([])));
    renderPage();
    expect(await screen.findByText(T.emptyNoMatch, undefined, WAIT)).toBeDefined();
  });

  it('says the index has not started when the indexer has not reported yet', async () => {
    mockFetch(() => ok(page([], { indexedUntil: null })));
    renderPage();
    expect((await screen.findAllByText(T.notIndexedYet, undefined, WAIT)).length).toBeGreaterThan(0);
  });

  it('turns a 422 SEARCH_TOO_BROAD into advice, with a retry', async () => {
    const calls = mockFetch(() => fail(422, 'too broad', 'SEARCH_TOO_BROAD'));
    renderPage();
    expect(await screen.findByText(T.apiErrors.tooBroad, undefined, WAIT)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: common.retry }));
    await waitFor(() => {
      expect(searchBodies(calls).length).toBeGreaterThan(1);
    }, WAIT);
  });

  it('shows a loading state while the first page is on its way', () => {
    mockFetch(() => never());
    renderPage();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('opens a result in a sheet with its headers and bodies, asking for that row by its own ts', async () => {
    const detail = {
      ...item(1),
      ip: '10.0.0.7',
      reqHeaders: { authorization: '[REDACTED]', 'x-request-id': 'req-1' },
      resHeaders: { 'content-type': 'application/json' },
      reqBody: '{"note":"refund declined"}',
      resBody: '{"error":"insufficient funds"}',
    };
    const calls = mockFetch((c) => {
      if (c.path.startsWith('/analytics/traffic/search/1')) return ok(detail);
      if (c.path.startsWith('/analytics/keys')) return ok([]); // the sheet looks the key up by name
      return ok(page([item(1)]));
    });
    renderPage();

    // The open request lives in the URL (the mocked router does not apply it, so the test does).
    fireEvent.click(await screen.findByRole('button', { name: /Open POST \/orders\/1/ }, WAIT), { detail: 1 });
    // A plain click waits out a possible double click before it opens the request.
    await waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    }, WAIT);
    expect(replace).toHaveBeenCalledWith('/analytics/search?req=1&ts=2026-09-29T10%3A00%3A01.123456Z', { scroll: false });
    cleanup();
    search = 'req=1&ts=2026-09-29T10%3A00%3A01.123456Z';
    renderPage();
    const dialog = await screen.findByRole('dialog', undefined, WAIT);
    expect(await within(dialog).findByText('authorization', undefined, WAIT)).toBeDefined();
    expect(within(dialog).getByText('[REDACTED]')).toBeDefined();
    expect(within(dialog).getByText('{"error":"insufficient funds"}')).toBeDefined();
    expect(within(dialog).getByText('10.0.0.7', { exact: false })).toBeDefined();
    expect(calls.some((c) => c.path === '/analytics/traffic/search/1?ts=2026-09-29T10%3A00%3A01.123456Z')).toBe(true);
  });

  it.each([
    ['analytics:read', ['api:update']],
    ['api:update', ['analytics:read']],
  ])('is closed to someone missing %s, and never queries', async (missing, held) => {
    granted = held;
    const calls = mockFetch(() => ok(page([item(1)])));
    renderPage();
    expect(await screen.findByText(auth.permissionGate.noAccessTitle)).toBeDefined();
    expect(document.body.textContent).toContain(missing);
    await settled();
    expect(searchBodies(calls)).toHaveLength(0);
  });
});
