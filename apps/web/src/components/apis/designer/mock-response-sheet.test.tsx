// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apisMessages from '@/messages/en/apis.json';
import commonMessages from '@/messages/en/common.json';
import { baseApi, wrap } from './test-utils';
import { MockResponseSheet } from './mock-response-sheet';

const M = apisMessages;

const mutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/use-apis', () => ({
  useUpdateApi: () => ({ mutateAsync }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MockResponseSheet', () => {
  it('saves the status code, body and parsed headers once enabled', async () => {
    render(wrap(<MockResponseSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.click(screen.getByLabelText(M.designer.mock.enable));
    fireEvent.change(screen.getByLabelText(M.designer.mock.statusCode), { target: { value: '503' } });
    fireEvent.change(screen.getByLabelText(M.designer.mock.body), { target: { value: '{"status":"down"}' } });
    fireEvent.change(screen.getByLabelText(M.designer.mock.headers), {
      target: { value: 'Content-Type: application/json' },
    });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        config: {
          mock: {
            code: 503,
            body: '{"status":"down"}',
            headers: [{ name: 'Content-Type', value: 'application/json' }],
          },
        },
      });
    });
  });

  it('rejects a status code outside 100-599', async () => {
    render(wrap(<MockResponseSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.click(screen.getByLabelText(M.designer.mock.enable));
    fireEvent.change(screen.getByLabelText(M.designer.mock.statusCode), { target: { value: '999' } });
    fireEvent.change(screen.getByLabelText(M.designer.mock.body), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    expect(await screen.findByText(M.designer.mock.codeRangeError)).toBeDefined();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
