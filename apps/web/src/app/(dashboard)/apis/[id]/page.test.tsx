// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import apisMessages from '@/messages/en/apis.json';
import authMessages from '@/messages/en/auth.json';
import commonMessages from '@/messages/en/common.json';
import dashboardMessages from '@/messages/en/dashboard.json';
import openapiMessages from '@/messages/en/openapi.json';
import { baseApi } from '@/components/apis/designer/test-utils';
import { usePermissions } from '@/hooks/use-permissions';
import ApiDetailPageGated from './page';

vi.mock('@/hooks/use-permissions', () => ({ usePermissions: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'api-1' }),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/use-apis', () => ({
  useApiDetail: () => ({
    data: { ...baseApi, keyCount: 0 },
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useApiKeys: () => ({ data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() }),
  useSetApiStatus: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// Every child that brings its own data hooks or providers: this test is only about the tab list's gates.
vi.mock('@/components/apis/api-config-card', () => ({ ApiConfigCard: () => null }));
vi.mock('@/components/apis/api-form-sheet', () => ({ ApiFormSheet: () => null }));
vi.mock('@/components/apis/clients-tab', () => ({ ClientsTab: () => null }));
vi.mock('@/components/apis/delete-api-dialog', () => ({ DeleteApiDialog: () => null }));
vi.mock('@/components/apis/designer/designer-tab', () => ({ DesignerTab: () => null }));
vi.mock('@/components/apis/endpoints/endpoints-tab', () => ({ EndpointsTab: () => null }));
vi.mock('@/components/apis/spec-source/spec-update-banner', () => ({ SpecUpdateBanner: () => null }));
vi.mock('@/components/apis/sync-status-badge', () => ({ SyncStatusBadge: () => null }));
vi.mock('@/components/apis/traffic-tab', () => ({ TrafficTab: () => null }));

function renderPage(granted: readonly string[]) {
  vi.mocked(usePermissions).mockReturnValue({ can: (p: string) => granted.includes(p), isLoading: false });
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={{
        apis: apisMessages,
        auth: authMessages,
        common: commonMessages,
        dashboard: dashboardMessages,
        openapi: openapiMessages,
      }}
    >
      <ApiDetailPageGated />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// V1-LOG-02: the Traffic tab shows real captured customer traffic, so it rides the same permission
// as the toggle that turns recording on (`api:update`), not the read permission of the page.
describe('API detail page: Traffic tab gate', () => {
  it('hides the Traffic tab for a reader without api:update', () => {
    renderPage(['api:read', 'key:read']);
    expect(screen.getByRole('tab', { name: apisMessages.tabs.overview })).toBeDefined();
    expect(screen.queryByRole('tab', { name: apisMessages.tabs.traffic })).toBeNull();
  });

  it('shows the Traffic tab with api:update', () => {
    renderPage(['api:read', 'api:update']);
    expect(screen.getByRole('tab', { name: apisMessages.tabs.traffic })).toBeDefined();
  });
});
