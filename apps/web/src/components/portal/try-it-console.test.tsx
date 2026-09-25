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

  describe('base URL', () => {
    const send = async (target: PortalApiDoc, path = '/users/42') => {
      fetchMock.mockResolvedValue({ status: 200, text: () => Promise.resolve('{}') } as Response);
      render(wrap(<TryItConsole api={target} />));
      fireEvent.change(screen.getByLabelText(M.tryIt.path), { target: { value: path } });
      fireEvent.change(screen.getByLabelText(M.tryIt.keyLabel.replace('{header}', 'X-Api-Key')), {
        target: { value: 'my-secret-key' },
      });
      fireEvent.click(screen.getByRole('button', { name: M.tryIt.send }));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      return (fetchMock.mock.calls[0] as [string])[0];
    };
    const withServer = (url: unknown): PortalApiDoc => ({
      ...api,
      gatewayListenPath: '/acme/orders/',
      oasDocument: { openapi: '3.0.3', servers: [{ url }], paths: {} },
    });

    it('comes from the sanitized document\'s servers[0].url, relative to the gateway origin', async () => {
      const url = await send({ ...withServer('/acme/renamed'), gatewayListenPath: '/somewhere/else/' });

      expect(url).toBe('https://localhost:33005/acme/renamed/users/42');
    });

    it('joins with exactly one slash, whether or not the listen path ends with one', async () => {
      expect(await send({ ...api, gatewayListenPath: '/acme/payments' })).toBe(
        'https://localhost:33005/acme/payments/users/42',
      );
    });

    it.each([
      ['an absolute URL', 'https://evil.example/'],
      ['a scheme-relative URL', '//evil.example/x'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['a non-string', { url: 'x' }],
    ])('never sends the key to %s in servers[0].url: it uses the listen path instead', async (_label, url) => {
      const sent = await send(withServer(url));

      expect(sent).toBe('https://localhost:33005/acme/orders/users/42');
      expect(sent).not.toContain('evil');
    });

    it.each([
      ['no servers', { openapi: '3.0.3', paths: {} }],
      ['servers that is not a list', { servers: 'nope' }],
      ['an empty servers list', { servers: [] }],
      ['no document (classic API)', null],
    ])('falls back to the listen path for %s', async (_label, oasDocument) => {
      expect(await send({ ...api, oasDocument })).toBe('https://localhost:33005/acme/orders/users/42');
    });
  });

  it('shows a hostile response body as text, not markup', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('<script>alert(1)</script><img src=x onerror="alert(1)">'),
    } as Response);
    const { container } = render(wrap(<TryItConsole api={api} />));

    fireEvent.change(screen.getByLabelText(M.tryIt.keyLabel.replace('{header}', 'X-Api-Key')), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: M.tryIt.send }));

    expect(await screen.findByText(/<script>alert\(1\)<\/script>/)).toBeDefined();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });
});
