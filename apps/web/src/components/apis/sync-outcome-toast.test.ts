import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('@/components/ui/sonner', () => ({ toast }));

import { toastSyncOutcome } from './sync-outcome-toast';

// Echo translator: returns the key plus its values, enough to see which message was chosen.
const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${JSON.stringify(values)}` : key) as unknown as Parameters<typeof toastSyncOutcome>[0];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toastSyncOutcome', () => {
  it('claims success only when the gateway reports SYNCED', () => {
    toastSyncOutcome(t, { syncStatus: 'SYNCED' }, 'Saved');
    expect(toast.success).toHaveBeenCalledWith('Saved');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('surfaces a FAILED sync with the gateway error instead of a success', () => {
    toastSyncOutcome(t, { syncStatus: 'FAILED', syncError: 'tyk 502' }, 'Saved');
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('tyk 502'));
  });

  it.each([
    ['PENDING', { syncStatus: 'PENDING' as const }],
    ['no status in the body', undefined],
  ])('reports %s as saved-but-unresolved, not synced', (_label, result) => {
    toastSyncOutcome(t, result, 'Saved');
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('sync.savedButPending'));
  });
});
