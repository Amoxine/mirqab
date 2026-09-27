// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import M from '@/messages/en/apis.json';
import C from '@/messages/en/common.json';
import { fail, mockFetch, never, ok, renderUi } from '@/components/apis/endpoints/test-utils';
import { TrafficTab } from './traffic-tab';
import type { TrafficPage } from '@/hooks/use-apis';

const okPage = (over: Partial<Extract<TrafficPage, { status: 'OK' }>> = {}): TrafficPage => ({
  status: 'OK',
  detailedRecording: true,
  range: '24h',
  page: 1,
  pageSize: 20,
  hasMore: false,
  items: [
    {
      timestamp: '2026-09-25T12:00:00.000Z',
      method: 'GET',
      path: '/orders',
      responseCode: 200,
      latencyMs: 12,
      request: { startLine: 'GET /orders HTTP/1.1', headers: { Host: 'orders' }, body: '', truncated: false },
      response: { startLine: 'HTTP/1.1 200 OK', headers: {}, body: '{"ok":true}', truncated: false },
    },
  ],
  ...over,
});

describe('TrafficTab', () => {
  it('shows a busy skeleton while it loads', () => {
    mockFetch(() => never());
    const { container } = renderUi(<TrafficTab apiId="api-1" />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('explains that detailed recording is off, distinct from an empty page', async () => {
    mockFetch(() => ok({ status: 'NOT_ENABLED' } satisfies TrafficPage));
    renderUi(<TrafficTab apiId="api-1" />);
    expect(await screen.findByText(M.trafficTab.notEnabledTitle)).toBeDefined();
    expect(screen.queryByText(M.trafficTab.empty)).toBeNull();
  });

  it('reports a read failure with a retry, distinct from NOT_ENABLED', async () => {
    const calls = mockFetch(() => ok({ status: 'FAILED' } satisfies TrafficPage));
    renderUi(<TrafficTab apiId="api-1" />);
    expect(await screen.findByText(M.trafficTab.failedTitle)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: C.retry }));
    await waitFor(() => {
      expect(calls.filter((c) => c.path.startsWith('/apis/api-1/traffic')).length).toBeGreaterThan(1);
    });
  });

  it('shows an empty window as "no traffic yet", not NOT_ENABLED', async () => {
    mockFetch(() => ok(okPage({ items: [] })));
    renderUi(<TrafficTab apiId="api-1" />);
    expect(await screen.findByText(M.trafficTab.empty)).toBeDefined();
    expect(screen.queryByText(M.trafficTab.notEnabledTitle)).toBeNull();
  });

  it('lists captured rows and opens the full request/response on "View"', async () => {
    mockFetch(() => ok(okPage()));
    renderUi(<TrafficTab apiId="api-1" />);
    expect(await screen.findByText('/orders')).toBeDefined();
    expect(screen.getByText('GET')).toBeDefined();
    expect(screen.getByText('200')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: M.trafficTab.view }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('GET /orders HTTP/1.1')).toBeDefined();
    expect(within(dialog).getByText('HTTP/1.1 200 OK')).toBeDefined();
    expect(within(dialog).getByText('{"ok":true}')).toBeDefined();
  });

  it('sends the selected range and resets to page 1', async () => {
    const calls = mockFetch(() => ok(okPage()));
    renderUi(<TrafficTab apiId="api-1" />);
    await screen.findByText('/orders');
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: M.trafficTab.ranges['1h'] }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/apis/api-1/traffic?range=1h&page=1')).toBe(true);
    });
  });

  it('pages forward only while hasMore, and back again', async () => {
    const calls = mockFetch((c) =>
      ok(okPage({ page: c.path.includes('page=2') ? 2 : 1, hasMore: !c.path.includes('page=2') })),
    );
    renderUi(<TrafficTab apiId="api-1" />);
    await screen.findByText('/orders');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/apis/api-1/traffic?range=24h&page=2')).toBe(true);
    });
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/apis/api-1/traffic?range=24h&page=1')).toBe(true);
    });
  });

  it('reports a 500 through the shared table error state', async () => {
    mockFetch(() => fail(500, 'boom'));
    renderUi(<TrafficTab apiId="api-1" />);
    expect(await screen.findByText('boom')).toBeDefined();
  });
});
