// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import type { NextRouter } from 'next/router';
import { ROW_CLICK_DELAY_MS } from '@open-gateway/ui';
import analytics from '@/messages/en/analytics.json';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { renderApp } from '@/components/dashboard/test-render';
import AuditLogsPage from './page';

const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  usePathname: () => '/audit-logs',
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));

const A = analytics.auditLogs;
const WAIT = { timeout: 8000 };
const row = (id: string, action: string, over: Record<string, unknown> = {}) => ({
  id,
  action,
  resource: 'keys',
  createdAt: '2026-09-29T10:00:00.000Z',
  ipAddress: '10.0.0.7',
  corrId: null,
  details: { resourceId: 'k-1' },
  user: { name: 'Ada', email: 'ada@example.com' },
  ...over,
});
const list = ok({
  data: [row('17', 'UPDATED'), row('18', 'DELETED')],
  meta: { page: 1, pageSize: 20, totalCount: 2, totalPages: 1 },
});

let calls: { path: string }[] = [];
beforeEach(() => {
  replace.mockClear();
  search = '';
  calls = mockFetch((call) => {
    if (call.path.startsWith('/audit-logs/17')) return ok(row('17', 'UPDATED', { corrId: 'corr-17' }));
    if (call.path.startsWith('/audit-logs?')) return list;
    return ok([]);
  });
});

describe('audit log page: opening an entry', () => {
  it('gives every row a hidden link to its detail (a click on the row follows it) and a named link on its time for a keyboard', async () => {
    renderApp(<AuditLogsPage />);
    await screen.findByText('Updated', undefined, WAIT);
    const hidden = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-row-link]'));
    expect(hidden.map((a) => a.getAttribute('href'))).toEqual(['/audit-logs?open=17', '/audit-logs?open=18']);
    expect(hidden.every((a) => a.hidden && a.getAttribute('aria-hidden') === 'true')).toBe(true);
    // The keyboard's link names what it opens, not just a date, and carries where focus returns to.
    const time = screen.getByRole('link', { name: /Open audit entry: Updated keys.*Sep 29, 2026/ });
    expect(time.getAttribute('href')).toBe('/audit-logs?open=17');
    expect(time.getAttribute('data-focus-return')).toBe('audit:17');
    expect(time.querySelector('.sr-only')?.textContent).toBe('Open audit entry: Updated keys');
    expect(screen.getByRole('link', { name: /Open audit entry: Deleted keys/ }).getAttribute('data-focus-return')).toBe('audit:18');
  });

  it('opens an entry by replacing the history entry and keeping the scroll, like search, so Back leaves the page', async () => {
    const replaceRoute = vi.fn();
    const pushRoute = vi.fn();
    // Outside Next's bundler `next/link` is the pages-router Link, which reads this context to navigate.
    const router = { push: pushRoute, replace: replaceRoute, prefetch: () => Promise.resolve() } as unknown as NextRouter;
    renderApp(
      <RouterContext.Provider value={router}>
        <AuditLogsPage />
      </RouterContext.Provider>,
    );
    const time = await screen.findByRole('link', { name: /Open audit entry: Updated keys/ }, WAIT);
    // Next cancels the browser's own navigation; recorded at document so jsdom is not asked to navigate.
    document.addEventListener('click', (event) => {
      event.preventDefault();
    }, { once: true });
    fireEvent.click(time, { detail: 1 });
    expect(replaceRoute).toHaveBeenCalledWith('/audit-logs?open=17', { scroll: false });
    expect(pushRoute).not.toHaveBeenCalled();
    // The row's hidden link does the same when the row's text is clicked.
    replaceRoute.mockClear();
    document.addEventListener('click', (event) => {
      event.preventDefault();
    }, { once: true });
    const keysCell = screen.getAllByText('keys', { selector: 'code' })[0];
    if (!keysCell) throw new Error('no keys cell');
    fireEvent.click(keysCell, { detail: 1 });
    await waitFor(() => {
      expect(replaceRoute).toHaveBeenCalledWith('/audit-logs?open=17', { scroll: false });
    }, { timeout: ROW_CLICK_DELAY_MS + 2000 });
    expect(pushRoute).not.toHaveBeenCalled();
  });

  it('opens the entry a link names, asking the API for it', async () => {
    search = 'open=17';
    renderApp(<AuditLogsPage />);
    const d = await screen.findByRole('dialog', undefined, WAIT);
    expect(await within(d).findByText('corr-17', undefined, WAIT)).toBeDefined();
    expect(calls.some((c) => c.path === '/audit-logs/17')).toBe(true);
  });

  it('opens an entry that is not on the page being shown', async () => {
    search = 'open=999';
    mockFetch((call) => {
      if (call.path.startsWith('/audit-logs/999')) return ok(row('999', 'CREATED', { corrId: 'far-away' }));
      return call.path.startsWith('/audit-logs?') ? list : ok([]);
    });
    renderApp(<AuditLogsPage />);
    const d = await screen.findByRole('dialog', undefined, WAIT);
    expect(await within(d).findByText('far-away', undefined, WAIT)).toBeDefined();
  });

  it.each([['an id that is not a number', 'open=..%2Fusers'], ['an empty id', 'open='], ['a negative id', 'open=-5']])(
    'ignores %s: no sheet, no request for it',
    async (_name, query) => {
      search = query;
      renderApp(<AuditLogsPage />);
      await screen.findByText('Updated', undefined, WAIT);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(calls.some((c) => /^\/audit-logs\/[^?]/.test(c.path))).toBe(false);
    },
  );

  it('takes only the entry out of the URL when the sheet closes', async () => {
    search = 'open=17&other=keep';
    renderApp(<AuditLogsPage />);
    await screen.findByRole('dialog', undefined, WAIT);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/audit-logs?other=keep', { scroll: false });
    }, WAIT);
  });

  it('closes to the bare page when the entry was the only thing in the URL', async () => {
    search = 'open=17';
    renderApp(<AuditLogsPage />);
    await screen.findByRole('dialog', undefined, WAIT);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/audit-logs', { scroll: false });
    }, WAIT);
  });

  it('still lists the entries with their action labels', async () => {
    renderApp(<AuditLogsPage />);
    expect(await screen.findByText('Updated', undefined, WAIT)).toBeDefined();
    expect(screen.getByText('Deleted')).toBeDefined();
    expect(A.title).toBe('Audit Logs');
  });
});
