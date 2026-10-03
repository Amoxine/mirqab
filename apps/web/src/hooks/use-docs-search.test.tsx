// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { useDocsSearch } from './use-docs-search';

afterEach(() => {
  vi.unstubAllGlobals();
});

function search(answer: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(answer), { status }))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={{}}>
        {children}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useDocsSearch('request'), { wrapper });
}

describe('useDocsSearch', () => {
  it('gives a heading or passage its page as the trail, since only the page carries breadcrumbs', async () => {
    const { result } = search([
      { type: 'page', content: 'Searching traffic', breadcrumbs: ['Documentation'], url: '/docs/searching-traffic' },
      { type: 'heading', content: 'Exact paths', url: '/docs/searching-traffic#exact-paths' },
      { type: 'text', content: 'A path is matched whole', url: '/docs/searching-traffic#exact-paths-2' },
      { type: 'page', content: 'Troubleshooting', breadcrumbs: ['Documentation'], url: '/docs/troubleshooting' },
      { type: 'heading', content: 'No traffic yet', url: '/docs/troubleshooting#no-traffic-yet' },
    ]);

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });
    expect(result.current.data).toEqual([
      { url: '/docs/searching-traffic', title: 'Searching traffic', trail: 'Documentation' },
      { url: '/docs/searching-traffic#exact-paths', title: 'Exact paths', trail: 'Documentation › Searching traffic' },
      { url: '/docs/searching-traffic#exact-paths-2', title: 'A path is matched whole', trail: 'Documentation › Searching traffic' },
      { url: '/docs/troubleshooting', title: 'Troubleshooting', trail: 'Documentation' },
      { url: '/docs/troubleshooting#no-traffic-yet', title: 'No traffic yet', trail: 'Documentation › Troubleshooting' },
    ]);
  });

  it('keeps a hit\'s own breadcrumbs when it has them', async () => {
    const { result } = search([
      { type: 'page', content: 'Searching traffic', breadcrumbs: ['Documentation'], url: '/docs/searching-traffic' },
      { type: 'heading', content: 'Exact paths', breadcrumbs: ['Guides'], url: '/docs/searching-traffic#exact-paths' },
    ]);

    await waitFor(() => {
      expect(result.current.data).toHaveLength(2);
    });
    expect(result.current.data?.[1]?.trail).toBe('Guides');
  });

  it('reports a failed search as an error and not as no results', async () => {
    const { result } = search({}, 500);

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.data).toBeUndefined();
  });
});
