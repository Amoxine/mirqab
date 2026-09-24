// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import portalMessages from '@/messages/en/portal.json';
import type { PortalApiDoc } from '@/hooks/use-portal';
import { wrap } from './test-utils';
import { TryItConsole } from './try-it-console';

const M = portalMessages;

const api: PortalApiDoc = {
  id: 'api-1',
  name: 'Orders',
  authType: 'AUTH_TOKEN',
  authHeaderName: 'X-Api-Key',
  gatewayListenPath: '/acme/orders/',
  oasDocument: null,
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

describe('TryItConsole', () => {
  it('calls the gateway directly at gatewayListenPath + path, with the pasted key in the configured header', async () => {
    // Only what TryItConsole reads off the response — not a full Response, hence the assertion.
    fetchMock.mockResolvedValue({ status: 200, text: () => Promise.resolve('{"ok":true}') } as Response);
    render(wrap(<TryItConsole api={api} />));

    fireEvent.change(screen.getByLabelText(M.tryIt.path), { target: { value: '/users/42' } });
    fireEvent.change(screen.getByLabelText(M.tryIt.keyLabel.replace('{header}', 'X-Api-Key')), {
      target: { value: 'my-secret-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: M.tryIt.send }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('https://localhost:33005/acme/orders/users/42', {
        method: 'GET',
        headers: { 'X-Api-Key': 'my-secret-key' },
      });
    });
    expect(await screen.findByText('200')).toBeDefined();
  });

  it('shows a network error inline instead of failing silently', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(wrap(<TryItConsole api={api} />));

    fireEvent.change(screen.getByLabelText(M.tryIt.path), { target: { value: '/x' } });
    fireEvent.change(screen.getByLabelText(M.tryIt.keyLabel.replace('{header}', 'X-Api-Key')), {
      target: { value: 'k' },
    });
    fireEvent.click(screen.getByRole('button', { name: M.tryIt.send }));

    expect(await screen.findByRole('alert')).toBeDefined();
  });

  it('requires a key before sending', async () => {
    render(wrap(<TryItConsole api={api} />));

    fireEvent.change(screen.getByLabelText(M.tryIt.path), { target: { value: '/x' } });
    fireEvent.click(screen.getByRole('button', { name: M.tryIt.send }));

    expect(await screen.findByText(M.tryIt.keyRequired)).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
