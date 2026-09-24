// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apisMessages from '@/messages/en/apis.json';
import commonMessages from '@/messages/en/common.json';
import { baseApi, wrap } from './test-utils';
import { ResponseCacheSheet } from './response-cache-sheet';

const M = apisMessages;

const mutateAsync = vi.fn().mockResolvedValue(undefined);
const invalidateMutateAsync = vi.fn().mockResolvedValue({ invalidated: true, keysDropped: 4 });
vi.mock('@/hooks/use-apis', () => ({
  useUpdateApi: () => ({ mutateAsync }),
  useInvalidateCache: () => ({ mutateAsync: invalidateMutateAsync, isPending: false }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ResponseCacheSheet', () => {
  it('saves timeout, all-safe-requests and parsed response codes once enabled', async () => {
    render(wrap(<ResponseCacheSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.click(screen.getByLabelText(M.designer.cache.enable));
    fireEvent.change(screen.getByLabelText(M.designer.cache.timeoutSeconds), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText(M.designer.cache.responseCodes), { target: { value: '200, 301' } });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        config: { cache: { timeoutSeconds: 30, cacheAllSafeRequests: true, cacheResponseCodes: [200, 301] } },
      });
    });
  });

  it('invalidates the cache on demand, independent of the form', async () => {
    render(wrap(<ResponseCacheSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.click(screen.getByRole('button', { name: M.designer.cache.invalidateNow }));

    await waitFor(() => {
      expect(invalidateMutateAsync).toHaveBeenCalled();
    });
    // The config-saving mutation is untouched by an invalidate click — the two actions are independent.
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
