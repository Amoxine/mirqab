// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import analyticsMessages from '@/messages/en/analytics.json';
import { usePermissions } from '@/hooks/use-permissions';
import { api } from '@/lib/api-client';
import { AuditTrafficAction, type AuditTrafficRow } from './audit-traffic-action';

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: vi.fn(),
}));

const DAY_MS = 24 * 3_600_000;

const apisRow: AuditTrafficRow = {
  resource: 'apis',
  createdAt: new Date().toISOString(),
  details: { resourceId: 'api-def-123' },
};

function renderAction(row: AuditTrafficRow, can: (permission: string) => boolean) {
  vi.mocked(usePermissions).mockReturnValue({ can, isLoading: false });
  return render(
    <NextIntlClientProvider locale="en" messages={{ analytics: analyticsMessages }}>
      <QueryClientProvider client={new QueryClient()}>
        <AuditTrafficAction row={row} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

const trigger = () => screen.queryByTitle(analyticsMessages.auditLogs.viewTraffic);

// AC-LOG01.2: the row action is unit-tested around `PermissionGate` directly, not through the whole
// page — it needs neither the `/audit-logs` list query nor the route's own server-side check.
describe('AuditTrafficAction (AC-LOG01.1-3)', () => {
  it('hides the action without analytics:read', () => {
    renderAction(apisRow, () => false);
    expect(trigger()).toBeNull();
  });

  it('hides the action for a non-apis resource even with analytics:read', () => {
    renderAction({ ...apisRow, resource: 'keys' }, () => true);
    expect(trigger()).toBeNull();
  });

  it('hides the action when the row has no api id in its details', () => {
    renderAction({ ...apisRow, details: null }, () => true);
    expect(trigger()).toBeNull();
  });

  it('hides the action for a row older than 30 days, whose window no range covers', () => {
    renderAction({ ...apisRow, createdAt: new Date(Date.now() - 31 * DAY_MS).toISOString() }, () => true);
    expect(trigger()).toBeNull();
  });

  it('fetches GET /audit-logs/traffic/:apiDefId and renders the summary when opened with analytics:read', async () => {
    const getSpy = vi.spyOn(api, 'get').mockResolvedValue({
      success: true,
      data: { requests: 1500, errors: 1, errorRate: 10, avgLatencyMs: 42 },
    });

    renderAction(apisRow, () => true);
    fireEvent.click(screen.getByTitle(analyticsMessages.auditLogs.viewTraffic));

    expect(getSpy).toHaveBeenCalledWith('/audit-logs/traffic/api-def-123?range=1h');
    // Real `Intl.NumberFormat('en')` output via `useFormat()`, same as the rest of the analytics UI —
    // the unit itself is localized (e.g. "ms" -> "م.ث" in Arabic), never a hand-written suffix.
    expect(await screen.findByText('1,500')).toBeDefined();
    expect(await screen.findByText('10.0%')).toBeDefined();
    expect(await screen.findByText('42 ms')).toBeDefined();

    getSpy.mockRestore();
  });

  it('asks for the narrowest range that still covers the row', () => {
    const getSpy = vi.spyOn(api, 'get').mockResolvedValue({
      success: true,
      data: { requests: 0, errors: 0, errorRate: 0, avgLatencyMs: 0 },
    });

    renderAction({ ...apisRow, createdAt: new Date(Date.now() - 2 * DAY_MS).toISOString() }, () => true);
    fireEvent.click(screen.getByTitle(analyticsMessages.auditLogs.viewTraffic));

    expect(getSpy).toHaveBeenCalledWith('/audit-logs/traffic/api-def-123?range=7d');

    getSpy.mockRestore();
  });
});
