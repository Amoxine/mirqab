// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import portalMessages from '@/messages/en/portal.json';
import { wrap } from './test-utils';
import { SubscribeSheet } from './subscribe-sheet';

const M = portalMessages;

const mutateAsync = vi.fn().mockResolvedValue({
  id: 'sub-1',
  applicationId: 'app-1',
  productId: 'prod-1',
  productName: 'Orders API',
  planId: 'plan-1',
  planName: 'Free',
  status: 'APPROVED',
  approvedAt: null,
  revokedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  keyValue: 'secret-key',
});

vi.mock('@/hooks/use-portal', () => ({
  usePortalProducts: () => ({ data: [{ id: 'prod-1', name: 'Orders API', slug: 'orders', description: null, apis: [], createdAt: '', updatedAt: '' }] }),
  usePortalPlans: () => ({ data: [{ id: 'plan-1', name: 'Free', description: null, rate: 10, per: 60, quotaMax: -1, quotaPeriod: 'MONTHLY', active: true, keyCount: 0, createdAt: '', updatedAt: '' }] }),
  useCreatePortalSubscription: () => ({ mutateAsync }),
}));

describe('SubscribeSheet', () => {
  it('subscribes to the selected product+plan and hands the minted key back to the caller', async () => {
    const onSubscribed = vi.fn();
    render(
      wrap(<SubscribeSheet applicationId="app-1" open onOpenChange={() => undefined} onSubscribed={onSubscribed} />),
    );

    fireEvent.click(screen.getByRole('combobox', { name: M.subscribe.product }));
    fireEvent.click(await screen.findByRole('option', { name: 'Orders API' }));
    fireEvent.click(screen.getByRole('combobox', { name: M.subscribe.plan }));
    fireEvent.click(await screen.findByRole('option', { name: 'Free' }));
    fireEvent.click(screen.getByRole('button', { name: M.subscribe.submit }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({ productId: 'prod-1', planId: 'plan-1' });
      expect(onSubscribed).toHaveBeenCalledWith(expect.objectContaining({ keyValue: 'secret-key' }));
    });
  });
});
