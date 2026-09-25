// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import S from '@/messages/en/specSource.json';
import { SpecUpdatesCard } from '@/components/dashboard/spec-updates-card';
import { mockFetch, ok, renderUi, type Call } from '@/components/apis/endpoints/test-utils';
import type { Candidate } from '@/lib/api/spec-source';
import { SpecUpdateBadge, SpecUpdateBanner } from './spec-update-banner';

const perms = vi.hoisted(() => ({ granted: new Set<string>(['api:read', 'api:update']) }));
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: (p: string) => perms.granted.has(p), isLoading: false }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/sonner', () => ({ toast }));

const PENDING: Candidate = {
  id: 'c1',
  contentHash: 'h'.repeat(64),
  state: 'PENDING',
  detectedAt: '2026-09-25T10:00:00.000Z',
  decidedAt: null,
  endpointCount: 4,
  baseVersionNo: 3,
  diff: { added: 3, removed: 1, changed: 2, governedRemoved: 1, governedChanged: 0 },
  format: 'yaml',
  openapiVersion: '3.0.3',
  findings: [],
};
const DIFF = {
  dryRun: true,
  applied: false,
  unchanged: false,
  versionNo: 3,
  findings: [],
  diff: { added: [], removed: [], changed: [] },
  governanceImpact: { removedGoverned: [], changedGoverned: [] },
};

const SOURCE = {
  configured: true,
  url: 'https://specs.example.com/…',
  enabled: true,
  intervalMinutes: 60,
  lastCheckedAt: null,
  lastSuccessAt: null,
  nextCheckAt: null,
  lastResult: 'CHANGED',
  lastErrorCode: null,
  consecutiveFailures: 0,
};
/** The banner reads the source first: candidates exist only for an API that watches a URL. */
const withSource = (route: (c: Call) => ReturnType<typeof ok>) => (c: Call) =>
  c.path === '/apis/api-1/spec-source' ? ok(SOURCE) : c.path === '/spec-updates' ? ok({ items: [] }) : route(c);

beforeEach(() => {
  vi.clearAllMocks();
  perms.granted = new Set(['api:read', 'api:update']);
});

describe('SpecUpdateBanner', () => {
  it('shows nothing while no version is pending', async () => {
    const calls = mockFetch(withSource(() => ok({ pending: null, history: [] })));
    renderUi(<SpecUpdateBanner apiId="api-1" />);
    await waitFor(() => {
      expect(calls.map((c) => c.path)).toEqual(['/apis/api-1/spec-source', '/apis/api-1/spec-candidates']);
    });
    expect(screen.queryByText(S.banner.title)).toBeNull();
  });

  it('shows the detected counts and the governed impact, with Review for api:update', async () => {
    mockFetch(withSource(() => ok({ pending: PENDING, history: [] })));
    renderUi(<SpecUpdateBanner apiId="api-1" />);
    expect(await screen.findByText(S.banner.title)).toBeDefined();
    expect(screen.getByText('3 added, 1 removed, 2 changed')).toBeDefined();
    expect(screen.getByText('1 endpoint with settings removed.')).toBeDefined();
    expect(screen.getByRole('button', { name: S.banner.review })).toBeDefined();
  });

  it('an API that watches no URL never asks for candidates', async () => {
    const calls = mockFetch(() => ok({ configured: false }));
    renderUi(<SpecUpdateBanner apiId="api-1" />);
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.map((c) => c.path)).toEqual(['/apis/api-1/spec-source']);
  });

  it('read-only (api:read only): "View" opens the diff with no Use / Dismiss and no api:update request', async () => {
    perms.granted = new Set(['api:read']);
    const calls = mockFetch(withSource((c) => (c.path.endsWith('/diff') ? ok(DIFF) : ok({ pending: PENDING, history: [] }))));
    renderUi(<SpecUpdateBanner apiId="api-1" />);
    await screen.findByText(S.banner.title);
    expect(screen.queryByRole('button', { name: S.banner.review })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: S.banner.view }));
    expect(await screen.findByText(S.review.readOnly)).toBeDefined();
    await waitFor(() => {
      expect(calls.some((c) => c.path === '/apis/api-1/spec-candidates/c1/diff')).toBe(true);
    });
    expect(screen.queryByRole('button', { name: S.review.apply })).toBeNull();
    expect(screen.queryByRole('button', { name: S.review.dismiss })).toBeNull();
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('disappears once the version is used (the candidates are reloaded)', async () => {
    let applied = false;
    const calls = mockFetch(withSource((c) => {
      if (c.path.includes('/apply')) {
        applied = true;
        return ok({ ...DIFF, applied: true, versionNo: 4 });
      }
      if (c.path.endsWith('/diff')) return ok({ ...DIFF, diff: { added: [{ key: 'a', method: 'GET', path: '/a', operationId: null, summary: null, tags: [], deprecated: false, securitySchemes: [] }], removed: [], changed: [] } });
      return ok({ pending: applied ? null : PENDING, history: [] });
    }));
    renderUi(<><SpecUpdateBanner apiId="api-1" /><SpecUpdatesCard /></>);
    fireEvent.click(await screen.findByRole('button', { name: S.banner.review }));
    await screen.findByText('1 added, 0 removed, 0 changed');
    const updatesBefore = calls.filter((c) => c.path === '/spec-updates').length;
    fireEvent.click(screen.getByRole('button', { name: S.review.apply }));
    await waitFor(() => {
      expect(screen.queryByText(S.banner.title)).toBeNull();
    });
    expect(calls.filter((c) => c.path === '/apis/api-1/spec-candidates').length).toBeGreaterThanOrEqual(2);
    // The tenant-wide list (dashboard card, same query) is reloaded too.
    await waitFor(() => {
      expect(calls.filter((c) => c.path === '/spec-updates').length).toBeGreaterThan(updatesBefore);
    });
  });

  it('disappears once the version is dismissed', async () => {
    let dismissed = false;
    const calls = mockFetch(withSource((c) => {
      if (c.path.endsWith('/dismiss')) {
        dismissed = true;
        return ok({ state: 'DISMISSED' });
      }
      if (c.path.endsWith('/diff')) return ok(DIFF);
      return ok({ pending: dismissed ? null : PENDING, history: [] });
    }));
    renderUi(<><SpecUpdateBanner apiId="api-1" /><SpecUpdatesCard /></>);
    fireEvent.click(await screen.findByRole('button', { name: S.banner.review }));
    await screen.findByText(S.dashboard.empty);
    const updatesBefore = calls.filter((c) => c.path === '/spec-updates').length;
    fireEvent.click(await screen.findByRole('button', { name: S.review.dismiss }));
    await waitFor(() => {
      expect(screen.queryByText(S.banner.title)).toBeNull();
    });
    await waitFor(() => {
      expect(calls.filter((c) => c.path === '/spec-updates').length).toBeGreaterThan(updatesBefore);
    });
  });

  it('Arabic: right-to-left with the Arabic text', async () => {
    mockFetch(withSource(() => ok({ pending: PENDING, history: [] })));
    const { container } = renderUi(<SpecUpdateBanner apiId="api-1" />, 'ar');
    expect(await screen.findByText('يتوفر إصدار جديد من المواصفة')).toBeDefined();
    expect(container.firstElementChild?.getAttribute('dir')).toBe('rtl');
  });
});

describe('SpecUpdateBadge', () => {
  it('is a label only: the API list shows it for rows with specUpdateAvailable, with no request of its own', () => {
    const calls = mockFetch(() => ok({}));
    renderUi(<SpecUpdateBadge />);
    expect(screen.getByText(S.badge.updateAvailable)).toBeDefined();
    expect(calls).toHaveLength(0);
  });
});
