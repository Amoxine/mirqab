// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { mockFetch, ok, renderUi } from '@/components/apis/endpoints/test-utils';
import { NotificationsBell } from './notifications-bell';

let granted: string[] = [];
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => granted.includes(p), isLoading: false }),
}));

const status = {
  gateway: { reachable: true, version: 'v5', latencyMs: 3, redis: 'pass', error: null },
  apis: { total: 1, synced: 0, pending: 0, failed: 1 },
  failedSyncs: [{ id: 'a1', name: 'Orders', slug: 'orders', syncError: 'x', lastSyncedAt: '2026-10-01T08:00:00Z' }],
};
const WAIT = { timeout: 8000 };

beforeEach(() => {
  granted = [];
  localStorage.clear();
});

describe('NotificationsBell', () => {
  it('asks only for the sources the user may read, counts unread, and marks them read for next time', async () => {
    granted = ['settings:read'];
    const calls = mockFetch((call) => (call.path === '/gateway/status' ? ok(status) : ok({ items: [] })));
    renderUi(<NotificationsBell />);

    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' }, WAIT);
    expect(calls.map((c) => c.path)).toEqual(['/gateway/status']);

    fireEvent.click(bell);
    expect(await screen.findByRole('link', { name: /Orders failed to sync/ })).toHaveProperty('pathname', '/apis/a1');
    fireEvent.click(screen.getByRole('button', { name: 'Mark all as read' }));

    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('mirqab-notifications-read') ?? '[]')).toEqual([
      'sync-failed:a1:2026-10-01T08:00:00Z',
    ]);
  });

  it('says so when there is nothing to report', async () => {
    granted = ['settings:read', 'api:read', 'analytics:read'];
    mockFetch((call) => {
      if (call.path === '/gateway/status') return ok({ ...status, failedSyncs: [] });
      if (call.path === '/spec-updates') return ok({ items: [] });
      return ok({ pipelineReady: true, pumpReachable: true, rawTablePresent: true, aggregateTablePresent: true, lastRecordAt: null, rowCount: 3 });
    });
    renderUi(<NotificationsBell />);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }, WAIT));
    expect(await screen.findByText('You are all caught up.')).toBeTruthy();
  });
});
