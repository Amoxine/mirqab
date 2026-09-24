// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apisMessages from '@/messages/en/apis.json';
import commonMessages from '@/messages/en/common.json';
import { baseApi, wrap } from './test-utils';
import { AuthenticationSheet } from './authentication-sheet';

const M = apisMessages;

const mutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/use-apis', () => ({
  useUpdateApi: () => ({ mutateAsync }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AuthenticationSheet', () => {
  it('saves a custom auth header without changing the auth type', async () => {
    render(wrap(<AuthenticationSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.change(screen.getByLabelText(M.designer.authentication.headerName), {
      target: { value: 'X-Api-Key' },
    });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        authType: 'AUTH_TOKEN',
        config: { authHeaderName: 'X-Api-Key' },
      });
    });
  });

  it('never offers HMAC as a selectable auth type and says so', () => {
    render(wrap(<AuthenticationSheet api={baseApi} open onOpenChange={() => undefined} />));

    expect(screen.queryByRole('option', { name: M.authTypes.HMAC })).toBeNull();
    expect(screen.getByText(M.designer.authentication.hmacParked)).toBeDefined();
  });

  it('offers BASIC and switches the auth type to it', async () => {
    render(wrap(<AuthenticationSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: M.authTypes.BASIC }));
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ authType: 'BASIC' }));
    });
  });
});
