// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apisMessages from '@/messages/en/apis.json';
import commonMessages from '@/messages/en/common.json';
import { at, baseApi, wrap } from './test-utils';
import { HeaderTransformSheet } from './header-transform-sheet';

const M = apisMessages;

const mutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/use-apis', () => ({
  useUpdateApi: () => ({ mutateAsync }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HeaderTransformSheet', () => {
  it('parses "Name: Value" add lines and one-per-line remove names, request and response independently', async () => {
    render(wrap(<HeaderTransformSheet api={baseApi} open onOpenChange={() => undefined} />));

    // Request, then response, in source order.
    const addBoxes = screen.getAllByLabelText(M.designer.headerTransform.add);
    const removeBoxes = screen.getAllByLabelText(M.designer.headerTransform.remove);
    fireEvent.change(at(addBoxes, 0), { target: { value: 'X-Request-Source: open-gateway' } });
    fireEvent.change(at(removeBoxes, 0), { target: { value: 'X-Internal-Token' } });
    fireEvent.change(at(addBoxes, 1), { target: { value: 'X-Served-By: open-gateway' } });

    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        config: {
          transformRequestHeaders: {
            add: [{ name: 'X-Request-Source', value: 'open-gateway' }],
            remove: ['X-Internal-Token'],
          },
          transformResponseHeaders: { add: [{ name: 'X-Served-By', value: 'open-gateway' }] },
        },
      });
    });
  });

  it('rejects an add line with no colon', async () => {
    render(wrap(<HeaderTransformSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.change(at(screen.getAllByLabelText(M.designer.headerTransform.add), 0), {
      target: { value: 'not-a-header-line' },
    });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    expect(await screen.findAllByText(M.designer.headerTransform.addLineFormatError)).not.toHaveLength(0);
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
