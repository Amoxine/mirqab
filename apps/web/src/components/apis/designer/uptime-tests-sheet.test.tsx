// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apisMessages from '@/messages/en/apis.json';
import commonMessages from '@/messages/en/common.json';
import { baseApi, wrap } from './test-utils';
import { UptimeTestsSheet } from './uptime-tests-sheet';

const M = apisMessages;

const mutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/use-apis', () => ({
  useUpdateApi: () => ({ mutateAsync }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('UptimeTestsSheet', () => {
  it('parses "url method timeout" lines, method and timeout optional', async () => {
    render(wrap(<UptimeTestsSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.change(screen.getByLabelText(M.designer.uptimeTests.probes), {
      target: { value: 'https://orders:4000/health GET 5\nhttps://orders:4000/ping' },
    });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        config: {
          uptimeTests: [
            { url: 'https://orders:4000/health', method: 'GET', timeoutSeconds: 5 },
            { url: 'https://orders:4000/ping' },
          ],
        },
      });
    });
  });

  it('clears the section on Clear', async () => {
    render(
      wrap(
        <UptimeTestsSheet
          api={{ ...baseApi, config: { uptimeTests: [{ url: 'https://orders:4000/health' }] } }}
          open
          onOpenChange={() => undefined}
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: M.designer.clearSection }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({ config: { uptimeTests: null } });
    });
  });
});
