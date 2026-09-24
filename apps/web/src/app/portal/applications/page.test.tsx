// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import portalMessages from '@/messages/en/portal.json';
import commonMessages from '@/messages/en/common.json';
import { wrap } from '@/components/portal/test-utils';
import PortalApplicationsPage from './page';

const M = portalMessages;

const createMutateAsync = vi.fn().mockResolvedValue({});
vi.mock('@/hooks/use-portal', () => ({
  usePortalApplications: () => ({ data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() }),
  useCreatePortalApplication: () => ({ mutateAsync: createMutateAsync }),
}));

beforeEach(() => {
  createMutateAsync.mockClear();
});

describe('PortalApplicationsPage', () => {
  it('shows the empty state when there are no applications', () => {
    render(wrap(<PortalApplicationsPage />));
    expect(screen.getByText(M.applications.empty)).toBeDefined();
  });

  it('creates an application from the Sheet', async () => {
    render(wrap(<PortalApplicationsPage />));

    fireEvent.click(screen.getByRole('button', { name: M.applications.createButton }));
    fireEvent.change(screen.getByLabelText(commonMessages.name), { target: { value: 'My App' } });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.create }));

    await waitFor(() => {
      expect(createMutateAsync).toHaveBeenCalledWith({ name: 'My App', description: undefined });
    });
  });

  it('rejects a name shorter than 2 characters', async () => {
    render(wrap(<PortalApplicationsPage />));

    fireEvent.click(screen.getByRole('button', { name: M.applications.createButton }));
    fireEvent.change(screen.getByLabelText(commonMessages.name), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.create }));

    expect(await screen.findByText(M.applications.errors.nameTooShort)).toBeDefined();
    expect(createMutateAsync).not.toHaveBeenCalled();
  });
});
