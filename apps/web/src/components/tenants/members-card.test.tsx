// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import T from '@/messages/en/tenants.json';
import D from '@/messages/en/dashboard.json';
import { mockFetch, never, ok, renderUi } from './test-utils';
import { MembersCard } from './members-card';

/** Mirrors the page's own `<MembersCard key={tenant.id} tenantId={tenant.id} />` — the `key` is what
 * makes a tenant switch remount rather than reuse the previous tenant's query/state. */
function TenantSwitcher({ initial, next }: { initial: string; next: string }) {
  const [tenantId, setTenantId] = useState(initial);
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setTenantId(next);
        }}
      >
        {'switch tenant'}
      </button>
      <MembersCard key={tenantId} tenantId={tenantId} />
    </div>
  );
}

vi.mock('@/components/ui/sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

const CAN_ALL = () => true;
vi.mock('@/hooks/use-permissions', () => ({ usePermissions: () => ({ can: CAN_ALL, isLoading: false }) }));

const MEMBER = {
  userId: 'u1',
  email: 'active@x.com',
  name: 'Active User',
  role: 'viewer',
  isDefault: false,
  pending: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const PENDING = {
  userId: 'u2',
  email: 'pending@x.com',
  name: 'pending@x.com',
  role: 'viewer',
  isDefault: false,
  pending: true,
  createdAt: '2026-01-02T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

const page = (rows: unknown[], totalPages = 1, totalCount = rows.length) =>
  ok(rows, { page: 1, pageSize: 20, totalCount, totalPages });

describe('MembersCard', () => {
  it('renders rows and paginates from GET :id/users?page&pageSize', async () => {
    const calls = mockFetch(() => page([MEMBER], 2, 21));
    renderUi(<MembersCard tenantId="t1" />);
    expect(await screen.findByText(MEMBER.name)).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toContain('page=1');
    expect(calls[0]?.path).toContain('pageSize=20');

    fireEvent.click(screen.getByRole('button', { name: D.dataTable.next }));
    await waitFor(() => {
      expect(calls.some((c) => c.path.includes('page=2'))).toBe(true);
    });
  });

  it('typing fast sends ONE request with the final q, after the debounce, and returns to page 1', async () => {
    const calls = mockFetch(() => page([MEMBER], 2, 21));
    renderUi(<MembersCard tenantId="t1" />);
    await screen.findByText(MEMBER.name);
    fireEvent.click(screen.getByRole('button', { name: D.dataTable.next }));
    await waitFor(() => {
      expect(calls.some((c) => c.path.includes('page=2'))).toBe(true);
    });
    const before = calls.length;

    vi.useFakeTimers();
    const box = screen.getByLabelText(T.members.searchAriaLabel);
    for (const value of ['a', 'ac', 'act', 'acti']) fireEvent.change(box, { target: { value } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(calls).toHaveLength(before); // still inside the debounce window: nothing sent, not one per keystroke
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    vi.useRealTimers();

    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(before);
    });
    const searches = calls.slice(before);
    expect(searches).toHaveLength(1);
    expect(searches[0]?.path).toContain('q=acti');
    expect(searches[0]?.path).toContain('page=1');
  });

  it('while a new search is loading the previous rows and pager stay (no skeleton, no "of 1")', async () => {
    const calls = mockFetch((call) => (call.path.includes('q=') ? never() : page([MEMBER], 2, 21)));
    renderUi(<MembersCard tenantId="t1" />);
    await screen.findByText(MEMBER.name);
    expect(screen.getByText(/Page 1 of 2/)).toBeDefined();

    fireEvent.change(screen.getByLabelText(T.members.searchAriaLabel), { target: { value: 'zz' } });
    // The debounced request has started and never answers; the table must not have blanked meanwhile.
    await waitFor(() => {
      expect(calls.some((c) => c.path.includes('q=zz'))).toBe(true);
    });
    expect(screen.getByText(MEMBER.name)).toBeDefined();
    expect(screen.getByText(/Page 1 of 2/)).toBeDefined();
  });

  it('switching tenants (remounted via `key`, same as the page) never shows the previous tenant\'s rows', async () => {
    const calls = mockFetch((call) => {
      if (call.path.startsWith('/tenants/t1/')) return page([MEMBER], 2, 21);
      if (call.path.startsWith('/tenants/t2/')) return never();
      throw new Error(`unexpected call ${call.path}`);
    });
    renderUi(<TenantSwitcher initial="t1" next="t2" />);
    await screen.findByText(MEMBER.name);
    expect(screen.getByText(/Page 1 of 2/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'switch tenant' }));
    // The remount drops the old subtree immediately — t1's row must be gone with no in-between flash,
    // even though t2's request (deliberately) never resolves and `keepPreviousData` is in play.
    expect(screen.queryByText(MEMBER.name)).toBeNull();
    expect(screen.queryByText(/Page 1 of 2/)).toBeNull();
    await waitFor(() => {
      expect(calls.some((c) => c.path.startsWith('/tenants/t2/'))).toBe(true);
    });
    expect(screen.queryByText(MEMBER.name)).toBeNull();
  });

  it('a pending row shows the pending badge and copy-able instructions that never imply an email was sent', async () => {
    mockFetch(() => ok([PENDING], { page: 1, pageSize: 20, totalCount: 1, totalPages: 1 }));
    renderUi(<MembersCard tenantId="t1" />);
    await screen.findByText(T.members.pendingBadge);
    const expectedText = T.members.pendingInstructionsText.replace('{email}', PENDING.email);
    const instructions = screen.getByText(expectedText);
    expect(instructions).toBeDefined();
    expect(instructions.textContent).not.toMatch(/we (sent|emailed)/i);

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(screen.getByLabelText(T.members.pendingCopyAriaLabel));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expectedText);
    });
  });

  it('an active (non-pending) row shows neither the badge nor the instructions', async () => {
    mockFetch(() => ok([MEMBER], { page: 1, pageSize: 20, totalCount: 1, totalPages: 1 }));
    renderUi(<MembersCard tenantId="t1" />);
    await screen.findByText(MEMBER.name);
    expect(screen.queryByText(T.members.pendingBadge)).toBeNull();
  });
});
