// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apisMessages from '@/messages/en/apis.json';
import { ApiRequestError } from '@/lib/api-client';
import { baseApi, wrap } from './test-utils';
import { TestRequestSheet } from './test-request-sheet';

const M = apisMessages;

const mutateAsync = vi.fn();
vi.mock('@/hooks/use-apis', () => ({
  useDebugApi: () => ({ mutateAsync, isPending: false }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TestRequestSheet', () => {
  it('runs the request and shows the response code', async () => {
    mutateAsync.mockResolvedValueOnce({ response: { code: 200, body: '{"ok":true}' } });
    render(wrap(<TestRequestSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.change(screen.getByLabelText(M.designer.testRequest.path), { target: { value: '/users/42' } });
    fireEvent.click(screen.getByRole('button', { name: M.designer.testRequest.run }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({ method: 'GET', path: '/users/42' });
    });
    expect(await screen.findByText('200')).toBeDefined();
  });

  it('shows the denied-host 400 as an inline error, not a silent failure', async () => {
    mutateAsync.mockRejectedValueOnce(new ApiRequestError('Host is not allowed', 400));
    render(wrap(<TestRequestSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.change(screen.getByLabelText(M.designer.testRequest.path), { target: { value: '/x' } });
    fireEvent.change(screen.getByLabelText(M.designer.testRequest.targetUrl), {
      target: { value: 'http://169.254.169.254' },
    });
    fireEvent.click(screen.getByRole('button', { name: M.designer.testRequest.run }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Host is not allowed');
  });
});
