// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import C from '@/messages/en/common.json';
import S from '@/messages/en/specSource.json';
import { fail, mockFetch, never, ok, renderUi } from '@/components/apis/endpoints/test-utils';
import type { SpecUpdateItem } from '@/lib/api/spec-source';
import { SpecUpdatesCard } from './spec-updates-card';

const ITEMS: SpecUpdateItem[] = [
  {
    apiId: 'api-1',
    apiName: 'Orders',
    candidateId: 'c1',
    detectedAt: '2026-09-25T10:00:00.000Z',
    diff: { added: 3, removed: 1, changed: 2, governedRemoved: 1, governedChanged: 1 },
  },
  {
    apiId: 'api-2',
    apiName: 'Billing',
    candidateId: 'c2',
    detectedAt: '2026-09-24T10:00:00.000Z',
    diff: { added: 1, removed: 0, changed: 0, governedRemoved: 0, governedChanged: 0 },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SpecUpdatesCard', () => {
  it('loading', () => {
    mockFetch(() => never());
    renderUi(<SpecUpdatesCard />);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('lists each API with a link to its Endpoints tab, the counts and the governed impact', async () => {
    mockFetch(() => ok({ items: ITEMS }));
    renderUi(<SpecUpdatesCard />);
    const link = await screen.findByRole('link', { name: 'Orders' });
    expect(link.getAttribute('href')).toBe('/apis/api-1?tab=endpoints');
    expect(screen.getByRole('link', { name: 'Billing' }).getAttribute('href')).toBe('/apis/api-2?tab=endpoints');
    expect(screen.getByText(/3 added, 1 removed, 2 changed/)).toBeDefined();
    expect(screen.getByText('2 endpoints with settings affected')).toBeDefined();
  });

  it('empty', async () => {
    mockFetch(() => ok({ items: [] }));
    renderUi(<SpecUpdatesCard />);
    expect(await screen.findByText(S.dashboard.empty)).toBeDefined();
  });

  it('error with a retry', async () => {
    const calls = mockFetch(() => fail(500, 'boom'));
    renderUi(<SpecUpdatesCard />);
    expect(await screen.findByText(S.dashboard.loadError)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: C.retry }));
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(1);
    });
  });
});
