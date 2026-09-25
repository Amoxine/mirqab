// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import M from '@/messages/en/openapi.json';
import S from '@/messages/en/specSource.json';
import { baseApi } from '@/components/apis/designer/test-utils';
import { EndpointsTab } from '@/components/apis/endpoints/endpoints-tab';
import { fail, mockFetch, ok, renderUi, type Call } from '@/components/apis/endpoints/test-utils';
import type { ApiDetail } from '@/hooks/use-apis';
import { queryKeys } from '@/lib/query-keys';

const perms = vi.hoisted(() => ({ granted: new Set<string>(['api:read', 'api:update']) }));
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => perms.granted.has(p), isLoading: false }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/sonner', () => ({ toast }));

const api: ApiDetail = { ...baseApi, keyCount: 0 };
const SOURCE = {
  configured: true,
  url: 'https://specs.example.com/…',
  enabled: true,
  intervalMinutes: 60,
  lastCheckedAt: '2026-09-25T10:00:00.000Z',
  lastSuccessAt: '2026-09-25T10:00:00.000Z',
  nextCheckAt: '2026-09-25T11:00:00.000Z',
  lastResult: 'CHANGED',
  lastErrorCode: null,
  consecutiveFailures: 0,
};
const PENDING = {
  id: 'c1',
  contentHash: 'h',
  state: 'PENDING',
  detectedAt: '2026-09-25T10:00:00.000Z',
  decidedAt: null,
  endpointCount: 1,
  baseVersionNo: 0,
  diff: { added: 1, removed: 0, changed: 0, governedRemoved: 0, governedChanged: 0 },
  format: 'yaml',
  openapiVersion: '3.0.3',
  findings: [],
};
const ROW = { key: 'a', method: 'GET', path: '/orders', operationId: 'a', summary: null, tags: [], deprecated: false, securitySchemes: [] };
const FIRST = {
  dryRun: true,
  applied: false,
  unchanged: false,
  versionNo: 0,
  findings: [],
  diff: { added: [ROW], removed: [], changed: [] },
  governanceImpact: { removedGoverned: [], changedGoverned: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  perms.granted = new Set(['api:read', 'api:update']);
});

describe('EndpointsTab — spec source in every state', () => {
  it('no stored spec: the source card and the banner are shown, and the first version applies with expectedVersion=0', async () => {
    const calls = mockFetch((c: Call) => {
      if (c.path === '/apis/api-1/endpoints') return fail(404, 'No specification');
      if (c.path === '/apis/api-1/spec-source') return ok(SOURCE);
      if (c.path === '/apis/api-1/spec-candidates') return ok({ pending: PENDING, history: [] });
      if (c.path.endsWith('/diff')) return ok(FIRST);
      if (c.path.includes('/apply')) return ok({ ...FIRST, dryRun: false, applied: true, versionNo: 1 });
      return ok({ items: [] });
    });
    renderUi(<EndpointsTab api={api} />);
    expect(await screen.findByText(M.noSpec.title)).toBeDefined();
    expect(await screen.findByText('https://specs.example.com/…')).toBeDefined();
    fireEvent.click(await screen.findByRole('button', { name: S.banner.review }));
    await screen.findByText('1 added, 0 removed, 0 changed');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: S.review.apply }).hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: S.review.apply }));
    await waitFor(() => {
      expect(calls.find((c) => c.path.includes('/apply'))?.path).toBe('/apis/api-1/spec-candidates/c1/apply?expectedVersion=0');
    });
  });

  it('no stored spec and no source: an api:update user can start watching a URL', async () => {
    mockFetch((c: Call) => (c.path === '/apis/api-1/endpoints' ? fail(404, 'No specification') : ok({ configured: false })));
    renderUi(<EndpointsTab api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: S.card.setUp }));
    expect(await screen.findByText(S.sheet.createTitle)).toBeDefined();
  });

  it('endpoints failing to load: the source card is still there', async () => {
    mockFetch((c: Call) => (c.path === '/apis/api-1/endpoints' ? fail(500, 'boom') : ok(SOURCE)));
    renderUi(<EndpointsTab api={api} />);
    expect(await screen.findByText('https://specs.example.com/…')).toBeDefined();
    expect(await screen.findByText(M.loadError, undefined, { timeout: 10_000 })).toBeDefined();
  });
});

describe('spec source polling', () => {
  const intervalOf = (client: ReturnType<typeof renderUi>['client'], key: readonly unknown[]) => {
    const query = client.getQueryCache().find({ queryKey: key });
    if (!query) throw new Error('no query');
    const option = (query.options as { refetchInterval?: unknown }).refetchInterval;
    return typeof option === 'function' ? (option as (q: typeof query) => unknown)(query) : option;
  };

  it('polls a configured source, not an unconfigured one, and stops after an error', async () => {
    let answer: 'configured' | 'none' | 'error' = 'configured';
    mockFetch((c: Call) => {
      if (c.path !== '/apis/api-1/spec-source') return fail(404, 'No specification');
      return answer === 'error' ? fail(500, 'boom') : ok(answer === 'configured' ? SOURCE : { configured: false });
    });
    const { client } = renderUi(<EndpointsTab api={api} />);
    await screen.findByText('https://specs.example.com/…');
    const key = queryKeys.apis.specSource('api-1');
    expect(intervalOf(client, key)).toBe(60_000);

    answer = 'none';
    await client.refetchQueries({ queryKey: key });
    expect(intervalOf(client, key)).toBe(false);

    answer = 'error';
    await client.refetchQueries({ queryKey: key });
    await waitFor(() => {
      expect(intervalOf(client, key)).toBe(false);
    });
  });
});
