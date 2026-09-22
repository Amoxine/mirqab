// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import authMessages from '@/messages/en/auth.json';
import AuditLogsPage from './page';

// PagePermissionGate only mounts its children once `usePermissions` resolves, so a real render
// needs QueryProvider + a mocked /auth/me response. Mocking the hook directly is the smaller,
// equally faithful test: it exercises the same gate the page ships with.
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: () => false, isLoading: false }),
}));

describe('AuditLogsPage', () => {
  it('renders the no-access card instead of the table when audit:read is missing', () => {
    render(
      <NextIntlClientProvider locale="en" messages={{ auth: authMessages }}>
        <AuditLogsPage />
      </NextIntlClientProvider>,
    );

    expect(screen.getByText(authMessages.permissionGate.noAccessTitle)).toBeDefined();
    expect(screen.getByText('audit:read')).toBeDefined();
  });
});
