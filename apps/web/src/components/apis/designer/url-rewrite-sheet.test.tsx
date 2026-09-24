// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apisMessages from '@/messages/en/apis.json';
import commonMessages from '@/messages/en/common.json';
import { baseApi, wrap } from './test-utils';
import { UrlRewriteSheet } from './url-rewrite-sheet';

const M = apisMessages;

const mutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/use-apis', () => ({
  useUpdateApi: () => ({ mutateAsync }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('UrlRewriteSheet', () => {
  it('sends null while the enable switch is off, ignoring whatever is typed', async () => {
    render(wrap(<UrlRewriteSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({ config: { urlRewrite: null } });
    });
  });

  it('requires pattern and rewriteTo once enabled, then saves both', async () => {
    render(wrap(<UrlRewriteSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.click(screen.getByLabelText(M.designer.urlRewrite.enable));
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));
    expect(await screen.findAllByText(M.designer.errors.required)).not.toHaveLength(0);
    expect(mutateAsync).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(M.designer.urlRewrite.pattern), { target: { value: '/old/(.*)' } });
    fireEvent.change(screen.getByLabelText(M.designer.urlRewrite.rewriteTo), { target: { value: '/new/$1' } });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        config: { urlRewrite: { pattern: '/old/(.*)', rewriteTo: '/new/$1' } },
      });
    });
  });
});
