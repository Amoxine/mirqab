// @vitest-environment jsdom
import { cloneElement, type ReactElement } from 'react';
import type * as Recharts from 'recharts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import analytics from '@/messages/en/analytics.json';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { renderApp } from '@/components/dashboard/test-render';
import { StatusCodeChart } from './status-code-chart';

let granted: string[] = [];
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/analytics',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));
// jsdom has no layout, so a ResponsiveContainer measures 0 x 0 and draws nothing; give the chart a size.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof Recharts>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 600, height: 280 }),
  };
});

const C = analytics.charts.statusCodes;
const WAIT = { timeout: 8000 };

beforeEach(() => {
  granted = [];
  mockFetch(() =>
    ok([
      { code: '2xx', count: 1200 },
      { code: '401', count: 30 },
      { code: '503', count: 4 },
    ]),
  );
});
afterEach(cleanup);

describe('StatusCodeChart accessibility', () => {
  it('is not a keyboard stop of its own: the figures are in the list, not behind the drawing', async () => {
    granted = ['analytics:read', 'api:update'];
    renderApp(<StatusCodeChart range="24h" />);
    await waitFor(() => {
      expect(document.querySelectorAll('.recharts-bar-rectangle').length).toBeGreaterThan(0);
    }, WAIT);
    // With its accessibility layer the drawing is a tab stop (`tabindex="0"`) and an `application` region.
    const chart = document.querySelector('.recharts-wrapper');
    if (!chart) throw new Error('no chart drawn');
    expect(chart.querySelectorAll('[tabindex="0"]')).toHaveLength(0);
    expect(chart.querySelectorAll('[role="application"]')).toHaveLength(0);
  });

  it('gives a focused status link a visible focus ring that survives forced colours', async () => {
    granted = ['analytics:read', 'api:update'];
    renderApp(<StatusCodeChart range="24h" />);
    const nav = await screen.findByRole('navigation', { name: C.browse }, WAIT);
    for (const link of within(nav).getAllByRole('link')) {
      expect(link.className).toContain('focus-visible:ring-2');
      expect(link.className).toContain('focus-visible:outline-hidden');
      expect(link.className).not.toContain('focus-visible:outline-none');
    }
  });

  it('lists the figures as text for someone who cannot open search, since the chart is only a picture to them', async () => {
    renderApp(<StatusCodeChart range="24h" />);
    const list = await screen.findByRole('list', { name: C.breakdown }, WAIT);
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['2xx: 1,200', '401: 30', '503: 4']);
    expect(screen.queryByRole('navigation', { name: C.browse })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('does not list the figures twice for someone who can search: the links already carry them', async () => {
    granted = ['analytics:read', 'api:update'];
    renderApp(<StatusCodeChart range="24h" />);
    await screen.findByRole('navigation', { name: C.browse }, WAIT);
    expect(screen.queryByRole('list', { name: C.breakdown })).toBeNull();
  });

  it('lists nothing when there is nothing to list', async () => {
    mockFetch(() => ok([]));
    renderApp(<StatusCodeChart range="24h" />);
    await screen.findByText(C.empty, undefined, WAIT);
    expect(screen.queryByRole('list', { name: C.breakdown })).toBeNull();
  });
});
