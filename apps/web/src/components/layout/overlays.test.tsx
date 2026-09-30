// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import common from '@/messages/en/common.json';
import dashboard from '@/messages/en/dashboard.json';
import nav from '@/messages/en/nav.json';
import { OverlaysProvider } from './overlays';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/' }));
vi.mock('@/hooks/use-permissions', () => ({ usePermissions: () => ({ can: () => true, isLoading: false }) }));

const hits = [
  { id: '/docs/how-it-works', type: 'page', content: 'How a request travels', breadcrumbs: ['Documentation'], url: '/docs/how-it-works' },
  { id: '/docs/how-it-works-2', type: 'heading', content: 'What each stage does', breadcrumbs: ['Documentation', 'How a request travels'], url: '/docs/how-it-works#what-each-stage-does' },
  { id: '/docs/how-it-works-3', type: 'text', content: 'The edge terminates TLS', breadcrumbs: [], url: '/docs/how-it-works#what-each-stage-does' },
];
let fetched: string[] = [];

function setup() {
  fetched = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      fetched.push(url);
      return Promise.resolve(new Response(JSON.stringify(hits), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={{ common, dashboard, nav }}>
        <OverlaysProvider>
          <div />
        </OverlaysProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  return screen.findByPlaceholderText(dashboard.palette.placeholder);
}

beforeEach(() => {
  push.mockClear();
});

describe('command palette documentation group', () => {
  it('always offers the documentation, and goes there', async () => {
    await setup();
    fireEvent.click(await screen.findByRole('option', { name: dashboard.palette.docsHome }));
    expect(push).toHaveBeenCalledWith('/docs');
  });

  it('does not search the docs for fewer than 2 characters', async () => {
    const input = await setup();
    fireEvent.change(input, { target: { value: 'r' } });
    await new Promise((r) => setTimeout(r, 400));
    expect(fetched).toHaveLength(0);
  });

  it('searches the docs in the UI language after a pause, lists one hit per section, and opens one', async () => {
    const input = await setup();
    fireEvent.change(input, { target: { value: 'request' } });

    expect(await screen.findByText('How a request travels', undefined, { timeout: 4000 })).toBeDefined();
    expect(fetched).toEqual(['/docs/search-index?locale=en&query=request']);
    expect(screen.getByText('What each stage does')).toBeDefined();
    expect(screen.getAllByText('Documentation › How a request travels')).toHaveLength(1);
    expect(screen.queryByText('The edge terminates TLS')).toBeNull(); // same section as the heading: one hit per url

    fireEvent.click(screen.getByText('What each stage does'));
    expect(push).toHaveBeenCalledWith('/docs/how-it-works#what-each-stage-does');
  });

  it('types once, asks once: a burst of keystrokes is one request', async () => {
    const input = await setup();
    for (const v of ['re', 'req', 'requ', 'reque']) fireEvent.change(input, { target: { value: v } });
    await waitFor(() => {
      expect(fetched.length).toBeGreaterThan(0);
    }, { timeout: 4000 });
    expect(fetched).toEqual(['/docs/search-index?locale=en&query=reque']);
  });
});
