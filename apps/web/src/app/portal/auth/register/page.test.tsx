// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import portalMessages from '@/messages/en/portal.json';
import { wrap } from '@/components/portal/test-utils';
import type * as PortalApiClient from '@/lib/portal-api-client';
import PortalRegisterPage from './page';

const M = portalMessages;

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/portal-api-client', async () => {
  const actual = await vi.importActual<typeof PortalApiClient>('@/lib/portal-api-client');
  return { ...actual, portalApi: { post } };
});

beforeEach(() => {
  post.mockReset();
});

describe('PortalRegisterPage', () => {
  it('posts tenantSlug/name/email/password and shows the check-your-email confirmation', async () => {
    post.mockResolvedValue({ id: 'dev-1', email: 'ada@example.com', name: 'Ada' });
    render(wrap(<PortalRegisterPage />));

    fireEvent.change(screen.getByLabelText(M.auth.register.tenantSlugLabel), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText(M.auth.register.nameLabel), { target: { value: 'Ada Lovelace' } });
    fireEvent.change(screen.getByLabelText(M.auth.register.emailLabel), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText(M.auth.register.passwordLabel), { target: { value: 'Passw0rd!23' } });
    fireEvent.change(screen.getByLabelText(M.auth.register.confirmPasswordLabel), { target: { value: 'Passw0rd!23' } });
    fireEvent.click(screen.getByRole('button', { name: M.auth.register.submit }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/portal/auth/register', {
        tenantSlug: 'acme',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'Passw0rd!23',
      });
    });
    expect(await screen.findByText(M.auth.register.checkEmail)).toBeDefined();
  });

  it('rejects a mismatched confirm-password before ever calling the API', async () => {
    render(wrap(<PortalRegisterPage />));

    fireEvent.change(screen.getByLabelText(M.auth.register.tenantSlugLabel), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText(M.auth.register.nameLabel), { target: { value: 'Ada Lovelace' } });
    fireEvent.change(screen.getByLabelText(M.auth.register.emailLabel), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText(M.auth.register.passwordLabel), { target: { value: 'Passw0rd!23' } });
    fireEvent.change(screen.getByLabelText(M.auth.register.confirmPasswordLabel), { target: { value: 'Different1' } });
    fireEvent.click(screen.getByRole('button', { name: M.auth.register.submit }));

    expect(await screen.findByText(M.auth.register.errors.passwordMismatch)).toBeDefined();
    expect(post).not.toHaveBeenCalled();
  });
});
