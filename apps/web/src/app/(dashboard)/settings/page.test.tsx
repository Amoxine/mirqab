// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import authMessages from '@/messages/en/auth.json';
import commonMessages from '@/messages/en/common.json';
import dashboardMessages from '@/messages/en/dashboard.json';
import settingsMessages from '@/messages/en/settings.json';
import arAuth from '@/messages/ar/auth.json';
import arCommon from '@/messages/ar/common.json';
import arDashboard from '@/messages/ar/dashboard.json';
import arSettings from '@/messages/ar/settings.json';
import { createFormat } from '@/hooks/use-format';
import SettingsPage from './page';

afterEach(cleanup);

// Same shortcut as the audit-logs page test: mock the permission hook the gate reads.
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: () => true, isLoading: false }),
}));

// What the API really sends: the admin URL of each node, host name and all.
const health = { reachable: true, version: '5.8.0', latencyMs: 12, redis: 'pass' as const, error: null };
const NODES = [
  { nodeUrl: 'http://tyk-gateway:8081/tyk', health },
  { nodeUrl: 'http://tyk-gateway-2:8081/tyk', health: { ...health, reachable: false, version: null, latencyMs: null } },
];
vi.mock('@/hooks/use-settings', () => ({
  useSettings: () => ({
    data: { tykOrgId: 'org-1', analyticsRetentionDays: 30, analyticsAggregateRetentionDays: 365 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useNodeHealth: () => ({ data: NODES, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
  useReloadGateways: () => ({ mutate: vi.fn(), isPending: false }),
}));

const MESSAGES = {
  en: { auth: authMessages, common: commonMessages, dashboard: dashboardMessages, settings: settingsMessages },
  ar: { auth: arAuth, common: arCommon, dashboard: arDashboard, settings: arSettings },
};

function renderNodesTab(locale: keyof typeof MESSAGES) {
  render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <SettingsPage />
    </NextIntlClientProvider>,
  );
  fireEvent.mouseDown(screen.getByRole('tab', { name: MESSAGES[locale].settings.tabs.nodes }), {
    button: 0,
    ctrlKey: false,
  });
}

describe('SettingsPage gateway nodes', () => {
  it('labels each node by position and never prints its URL', () => {
    renderNodesTab('en');

    expect(screen.getByText('Node 1')).toBeDefined();
    expect(screen.getByText('Node 2')).toBeDefined();
    expect(document.body.textContent).not.toMatch(/tyk|8081|http:/i);
  });

  it.each(['en', 'ar'] as const)('writes the latency in the UI language in %s, not as a hardcoded "ms"', (locale) => {
    renderNodesTab(locale);

    expect(screen.getByText(createFormat(locale).ms(12))).toBeDefined();
    if (locale === 'ar') expect(document.body.textContent).not.toMatch(/\d ms\b/);
  });
});
