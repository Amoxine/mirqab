// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apisMessages from '@/messages/en/apis.json';
import commonMessages from '@/messages/en/common.json';
import { baseApi, wrap } from './test-utils';
import { IpAccessSheet } from './ip-access-sheet';

const M = apisMessages;

const mutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/use-apis', () => ({
  useUpdateApi: () => ({ mutateAsync }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('IpAccessSheet', () => {
  it('parses one entry per line for allow and block independently', async () => {
    render(wrap(<IpAccessSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.change(screen.getByLabelText(M.designer.ipAccess.allow), { target: { value: '10.0.0.0/8' } });
    fireEvent.change(screen.getByLabelText(M.designer.ipAccess.block), {
      target: { value: '203.0.113.7\n203.0.113.8' },
    });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        config: { ipAccessControl: { allow: ['10.0.0.0/8'], block: ['203.0.113.7', '203.0.113.8'] } },
      });
    });
  });

  it('clears the section when both lists are emptied', async () => {
    render(
      wrap(
        <IpAccessSheet
          api={{ ...baseApi, config: { ipAccessControl: { allow: ['10.0.0.0/8'] } } }}
          open
          onOpenChange={() => undefined}
        />,
      ),
    );

    fireEvent.change(screen.getByLabelText(M.designer.ipAccess.allow), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({ config: { ipAccessControl: null } });
    });
  });
});
