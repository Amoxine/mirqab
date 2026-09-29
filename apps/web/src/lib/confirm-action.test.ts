import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/sonner', () => ({ toast }));

import { confirmAction } from './confirm-action';

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('confirmAction', () => {
  it('toasts the success, closes, then calls onDone with the result', async () => {
    const order: string[] = [];
    await confirmAction({
      run: () => Promise.resolve({ id: 7 }),
      success: (r) => `deleted ${String(r.id)}`,
      failed: 'nope',
      close: () => order.push('close'),
      onDone: (r) => order.push(`done ${String(r.id)}`),
    });
    expect(toast.success).toHaveBeenCalledWith('deleted 7');
    expect(order).toEqual(['close', 'done 7']);
  });

  it('shows the server’s own message on failure and keeps the dialog open by default', async () => {
    const close = vi.fn();
    await confirmAction({
      run: () => Promise.reject(new Error('Role still has members')),
      failed: 'fallback',
      close,
    });
    expect(toast.error).toHaveBeenCalledWith('Role still has members');
    expect(close).not.toHaveBeenCalled();
  });

  it('falls back to its own text for a non-Error rejection, and closes when asked to', async () => {
    const close = vi.fn();
    await confirmAction({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point: a non-Error rejection
      run: () => Promise.reject('boom'),
      failed: 'fallback',
      close,
      closeOnError: true,
    });
    expect(toast.error).toHaveBeenCalledWith('fallback');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('shows no success toast when none is given (the result is revealed elsewhere)', async () => {
    await confirmAction({ run: () => Promise.resolve(1), failed: 'x', close: vi.fn() });
    expect(toast.success).not.toHaveBeenCalled();
  });
});
