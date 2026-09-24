// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apisMessages from '@/messages/en/apis.json';
import commonMessages from '@/messages/en/common.json';
import { baseApi, wrap } from './test-utils';
import { LoadBalancingSheet } from './load-balancing-sheet';

const M = apisMessages;

const mutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/use-apis', () => ({
  useUpdateApi: () => ({ mutateAsync }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LoadBalancingSheet', () => {
  it('parses "url weight" lines into targets', async () => {
    render(wrap(<LoadBalancingSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.change(screen.getByLabelText(M.designer.loadBalancing.targets), {
      target: { value: 'http://orders-b:4000 5\nhttp://orders-c:4000 1' },
    });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        config: {
          loadBalancing: {
            targets: [
              { url: 'http://orders-b:4000', weight: 5 },
              { url: 'http://orders-c:4000', weight: 1 },
            ],
            skipUnavailableHosts: false,
          },
        },
      });
    });
  });

  it('rejects a line missing the weight', async () => {
    render(wrap(<LoadBalancingSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.change(screen.getByLabelText(M.designer.loadBalancing.targets), {
      target: { value: 'http://orders-b:4000' },
    });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    expect(await screen.findByText(M.designer.loadBalancing.lineFormatError)).toBeDefined();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
