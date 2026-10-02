// @vitest-environment jsdom
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import analytics from '@/messages/en/analytics.json';
import { fail, mockFetch, never, ok } from '@/components/apis/endpoints/test-utils';
import { renderApp } from '@/components/dashboard/test-render';
import type { TrafficSearchItem } from '@/hooks/use-traffic-search';
import { SEARCH_LIMITS } from '@/lib/traffic-search';
import { SearchDetailSheet } from './search-detail-sheet';

let granted: string[] = [];
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));

const API_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const KEY_ID = '5f1b5e0e-0d3c-4d7e-9a61-0b9d2f6a7c11';
const D = analytics.search.detail;
const WAIT = { timeout: 8000 };

const item = (n: number, over: Partial<TrafficSearchItem> = {}): TrafficSearchItem => ({
  id: String(n),
  ts: `2026-09-29T10:00:0${String(n)}.123456Z`,
  apiId: API_ID,
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
const detailOf = (i: TrafficSearchItem) => ({
  ...i,
  ip: '10.0.0.7',
  reqHeaders: { 'x-request-id': 'req-1' },
  resHeaders: { 'content-type': 'application/json' },
  reqBody: '{"note":"refund declined"}',
  resBody: '{"error":"insufficient funds"}',
});
const keyRow = { apiKeyId: KEY_ID, name: 'qbus-web', status: 'ACTIVE', apiDefName: 'Orders API', requests: 1, errors: 0, errorRate: 0, avgLatencyMs: 1 };

interface Over {
  target?: { id: string; ts: string } | null;
  listItem?: TrafficSearchItem;
  previous?: TrafficSearchItem;
  next?: TrafficSearchItem;
  position?: { index: number; count: number };
  tokens?: string[];
  onAdd?: (text: string) => void;
  onNavigate?: (item: TrafficSearchItem) => void;
  onClose?: () => void;
}
function renderSheet(over: Over = {}) {
  const first = item(1);
  const props = {
    target: { id: first.id, ts: first.ts },
    listItem: first,
    range: '24h' as const,
    similar: { tokens: over.tokens ?? [], onAdd: over.onAdd ?? vi.fn() },
    onNavigate: over.onNavigate ?? vi.fn(),
    onClose: over.onClose ?? vi.fn(),
    previous: over.previous,
    next: over.next,
    position: over.position,
    ...('target' in over ? { target: over.target } : {}),
    ...('listItem' in over ? { listItem: over.listItem } : {}),
  };
  return renderApp(<SearchDetailSheet {...props} target={props.target ?? null} />);
}
const dialog = () => screen.findByRole('dialog', undefined, WAIT);
/** The position message as it reads: its `<bdi>` tag (which isolates the request) is markup, not text. */
const positionText = (index: number, count: number, request: string) =>
  D.position.replace(/<\/?bdi>/g, '').replace('{index}', String(index)).replace('{count}', String(count)).replace('{request}', request);
/** Matches the position line by its whole text: the request in it is its own element, so the text is split across nodes. */
const liveText = (text: string) => (_content: string, element: Element | null) =>
  element?.getAttribute('aria-live') === 'polite' && element.textContent === text;
/** An action that is off but still reachable: `aria-disabled`, never the `disabled` attribute that drops it from the tab order. */
const isOff = (button: HTMLElement) => button.getAttribute('aria-disabled') === 'true' && !button.hasAttribute('disabled');
const reasonOf = (button: HTMLElement) =>
  document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent;

beforeEach(() => {
  granted = ['analytics:read', 'api:update', 'api:read', 'key:read'];
  mockFetch((call) => {
    if (call.path.startsWith('/analytics/traffic/search/')) return ok(detailOf(item(1)));
    if (call.path.startsWith('/analytics/keys')) return ok([keyRow]);
    return ok([]);
  });
});

describe('SearchDetailSheet: a path that is one long unbroken token', () => {
  const TOKEN = 'a1b2c3d4'.repeat(15);
  const path = `/v1/${TOKEN}/orders/${TOKEN}`;

  it('lets the path in the title wrap anywhere, kept left to right, so it cannot widen the sheet past the screen', async () => {
    const wild = item(1, { path });
    renderSheet({ target: { id: wild.id, ts: wild.ts }, listItem: wild });
    const d = await dialog();
    const title = within(d).getByText(`POST ${path}`);
    expect(title.getAttribute('dir')).toBe('ltr');
    expect(title.className).toContain('[overflow-wrap:anywhere]');
    expect(title.className).toContain('min-w-0');
  });

  it('isolates the request in the position line as left to right, and lets that line wrap anywhere too', async () => {
    const wild = item(1, { path });
    renderSheet({ target: { id: wild.id, ts: wild.ts }, listItem: wild, next: item(2), position: { index: 1, count: 2 } });
    const d = await dialog();
    const live = d.querySelector('[aria-live="polite"]');
    if (!live) throw new Error('no position line');
    const request = live.querySelector('bdi');
    expect(request?.getAttribute('dir')).toBe('ltr');
    expect(request?.textContent).toBe(`POST ${path}, 500`);
    expect(live.className).toContain('[overflow-wrap:anywhere]');
    // The sentence around it is still the translated one, read as before.
    expect(live.textContent).toBe(positionText(1, 2, `POST ${path}, 500`));
  });
});

describe('SearchDetailSheet: what it shows', () => {
  it('shows the request line and status from the loaded row at once, and asks for that row by id and ts', async () => {
    const calls = mockFetch((call) => (call.path.startsWith('/analytics/traffic/search/') ? never() : ok([])));
    renderSheet();
    const d = await dialog();
    expect(within(d).getByText('POST /orders/1')).toBeDefined();
    expect(within(d).getByText('500')).toBeDefined();
    expect(calls.some((c) => c.path === '/analytics/traffic/search/1?ts=2026-09-29T10%3A00%3A01.123456Z')).toBe(true);
  });

  it('shows the request line and status from the response when the row is not in the loaded page (a shared link)', async () => {
    renderSheet({ listItem: undefined });
    const d = await dialog();
    // The title only: the request's own dump repeats the same line further down.
    expect(await within(d).findByRole('heading', { name: 'POST /orders/1 500' }, WAIT)).toBeDefined();
  });

  it('says the request could not be loaded, with a retry, when the detail fails', async () => {
    mockFetch((call) => (call.path.startsWith('/analytics/traffic/search/') ? fail(404, 'gone') : ok([])));
    renderSheet({ listItem: undefined });
    const d = await dialog();
    expect(await within(d).findByText(D.loadError, undefined, WAIT)).toBeDefined();
    expect(within(d).getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('is closed, and asks for nothing, without a target', () => {
    const calls = mockFetch(() => ok([]));
    renderSheet({ target: null, listItem: undefined });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('SearchDetailSheet: links to the API and the key', () => {
  it('links the API, and the key once its alias is found among the keys', async () => {
    renderSheet();
    const d = await dialog();
    expect(within(d).getByRole('link', { name: 'Orders API' }).getAttribute('href')).toBe(`/apis/${API_ID}`);
    const key = await within(d).findByRole('link', { name: 'qbus-web' }, WAIT);
    expect(key.getAttribute('href')).toBe(`/keys/${KEY_ID}`);
  });

  it('shows the key as plain text when two keys share its name: names are not unique, so no link would be right', async () => {
    mockFetch((call) => {
      if (call.path.startsWith('/analytics/keys')) return ok([keyRow, { ...keyRow, apiKeyId: 'other-key-id' }]);
      return ok(detailOf(item(1)));
    });
    renderSheet();
    const d = await dialog();
    await waitFor(() => {
      expect(within(d).getByText('qbus-web')).toBeDefined();
    }, WAIT);
    // Give the keys time to arrive, then check that still no link appeared.
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'qbus-web' })).toBeNull();
    }, WAIT);
    expect(within(d).queryByRole('link', { name: 'qbus-web' })).toBeNull();
  });

  it('shows the key as plain text when no key has that alias', async () => {
    mockFetch((call) => (call.path.startsWith('/analytics/keys') ? ok([]) : ok(detailOf(item(1)))));
    renderSheet();
    const d = await dialog();
    await waitFor(() => {
      expect(within(d).getByText('qbus-web')).toBeDefined();
    }, WAIT);
    expect(within(d).queryByRole('link', { name: 'qbus-web' })).toBeNull();
  });

  it('shows neither as a link for someone who may not open those pages', async () => {
    granted = ['analytics:read', 'api:update'];
    renderSheet();
    const d = await dialog();
    await waitFor(() => {
      expect(within(d).getByText('qbus-web')).toBeDefined();
    }, WAIT);
    expect(within(d).queryByRole('link', { name: 'Orders API' })).toBeNull();
    expect(within(d).queryByRole('link', { name: 'qbus-web' })).toBeNull();
  });

  it('has no API line for a request that matched no API', async () => {
    renderSheet({ listItem: item(1, { apiId: null, apiName: null }) });
    const d = await dialog();
    expect(within(d).queryByRole('link', { name: 'Orders API' })).toBeNull();
  });
});

describe('SearchDetailSheet: find similar', () => {
  it.each([
    [D.similar.path, 'path:/orders/1'],
    [D.similar.status, 'status:500'],
    [D.similar.api, `api:${API_ID}`],
    [D.similar.key, 'key:qbus-web'],
  ])('"%s" adds %s to the search', async (label, token) => {
    const onAdd = vi.fn();
    renderSheet({ onAdd });
    const d = await dialog();
    fireEvent.click(within(d).getByRole('button', { name: label }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(token);
  });

  it('turns off an action whose filter is already in the search, and says why', async () => {
    const onAdd = vi.fn();
    renderSheet({ onAdd, tokens: ['status:500'] });
    const d = await dialog();
    const button = within(d).getByRole('button', { name: D.similar.status });
    expect(isOff(button)).toBe(true);
    // The reason is text on the page, and the button is described by it, so it is read with the button.
    const reason = D.similarBlocked.present.replace('{action}', D.similar.status);
    expect(within(d).getByText(reason)).toBeDefined();
    expect(reasonOf(button)).toBe(reason);
    fireEvent.click(button);
    expect(onAdd).not.toHaveBeenCalled();
    const path = within(d).getByRole('button', { name: D.similar.path });
    expect(isOff(path)).toBe(false);
    expect(path.hasAttribute('aria-describedby')).toBe(false);
  });

  it('turns every action off once the search holds the most filters it can, and says so', async () => {
    const onAdd = vi.fn();
    const full = Array.from({ length: SEARCH_LIMITS.maxClauses }, (_, i) => `latency:>${String(i + 1)}`);
    renderSheet({ onAdd, tokens: full });
    const d = await dialog();
    for (const label of [D.similar.path, D.similar.status, D.similar.api, D.similar.key]) {
      const button = within(d).getByRole('button', { name: label });
      expect(isOff(button)).toBe(true);
      // All four are described by the one note.
      expect(reasonOf(button)).toBe(D.similarBlocked.full.replace('{max}', String(SEARCH_LIMITS.maxClauses)));
      fireEvent.click(button);
    }
    expect(onAdd).not.toHaveBeenCalled();
    // One note for all four, not the same sentence four times.
    const note = D.similarBlocked.full.replace('{max}', String(SEARCH_LIMITS.maxClauses));
    expect(within(d).getAllByText(note)).toHaveLength(1);
  });

  it('turns off what this request has no usable value for: no API, no key, a path too short to search', async () => {
    renderSheet({ listItem: item(1, { apiId: null, apiName: null, keyAlias: '', path: '/a' }) });
    const d = await dialog();
    for (const label of [D.similar.api, D.similar.key, D.similar.path]) {
      const button = within(d).getByRole('button', { name: label });
      expect(isOff(button)).toBe(true);
      const reason = D.similarBlocked.unsupported.replace('{action}', label);
      expect(within(d).getByText(reason)).toBeDefined();
      expect(reasonOf(button)).toBe(reason);
    }
    expect(isOff(within(d).getByRole('button', { name: D.similar.status }))).toBe(false);
  });
});

describe('SearchDetailSheet: previous and next', () => {
  it('steps to the neighbouring results of the loaded page', async () => {
    const onNavigate = vi.fn();
    const previous = item(0);
    const next = item(2);
    renderSheet({ previous, next, onNavigate, position: { index: 2, count: 3 } });
    const d = await dialog();
    fireEvent.click(within(d).getByRole('button', { name: D.previous }));
    expect(onNavigate).toHaveBeenLastCalledWith(previous);
    fireEvent.click(within(d).getByRole('button', { name: D.next }));
    expect(onNavigate).toHaveBeenLastCalledWith(next);
    // The live text names the request now shown, not only its place in the list.
    expect(
      within(d).getByText(
        liveText(positionText(2, 3, 'POST /orders/1, 500')),
      ),
    ).toBeDefined();
  });

  it('turns a direction off at the end of the loaded results', async () => {
    renderSheet({ next: item(2), position: { index: 1, count: 2 } });
    const d = await dialog();
    expect(isOff(within(d).getByRole('button', { name: D.previous }))).toBe(true);
    expect(isOff(within(d).getByRole('button', { name: D.next }))).toBe(false);
  });

  it('keeps focus on the button that has just run out of results, instead of dropping it', async () => {
    const onNavigate = vi.fn();
    renderSheet({ previous: item(0), onNavigate, position: { index: 2, count: 2 } });
    const d = await dialog();
    const next = within(d).getByRole('button', { name: D.next });
    expect(isOff(next)).toBe(true);
    next.focus();
    expect(document.activeElement).toBe(next);
    fireEvent.click(next);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(next);
  });

  it('offers neither for a request that is not among the loaded results', async () => {
    renderSheet({ listItem: undefined });
    const d = await dialog();
    expect(within(d).queryByRole('button', { name: D.previous })).toBeNull();
    expect(within(d).queryByRole('button', { name: D.next })).toBeNull();
  });
});

describe('SearchDetailSheet: focus when it closes', () => {
  function Closable({ withRow }: { withRow: boolean }) {
    const [open, setOpen] = useState(true);
    const first = item(1);
    return (
      <>
        <main id="main-content" tabIndex={-1}>
          {'page'}
        </main>
        {withRow && (
          <button type="button" data-focus-return={`search:${first.id}@${first.ts}`}>
            {'row 1'}
          </button>
        )}
        <SearchDetailSheet
          target={open ? { id: first.id, ts: first.ts } : null}
          listItem={first}
          range="24h"
          similar={{ tokens: [], onAdd: vi.fn() }}
          onNavigate={vi.fn()}
          onClose={() => {
            setOpen(false);
          }}
        />
      </>
    );
  }
  const close = async () => {
    await dialog();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    }, WAIT);
  };

  it('returns focus to the row that is open, which a click on its text never focused', async () => {
    renderApp(<Closable withRow />);
    await close();
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('row 1');
    }, WAIT);
  });

  it('falls back to the page’s main content when that row is no longer listed', async () => {
    renderApp(<Closable withRow={false} />);
    await close();
    await waitFor(() => {
      expect(document.activeElement?.id).toBe('main-content');
    }, WAIT);
  });
});
