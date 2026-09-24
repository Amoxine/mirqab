// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apisMessages from '@/messages/en/apis.json';
import commonMessages from '@/messages/en/common.json';
import { at, baseApi, wrap } from './test-utils';
import { BodyTransformSheet } from './body-transform-sheet';

const M = apisMessages;

const mutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/use-apis', () => ({
  useUpdateApi: () => ({ mutateAsync }),
}));

describe('BodyTransformSheet', () => {
  it('enables the request direction only, leaving the response one null', async () => {
    render(wrap(<BodyTransformSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.click(screen.getByLabelText(M.designer.bodyTransform.request));
    // Request's template field is the first of the two (request, then response).
    fireEvent.change(at(screen.getAllByLabelText(M.designer.bodyTransform.template), 0), {
      target: { value: '{{.}}' },
    });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        config: {
          transformRequestBody: { format: 'json', body: '{{.}}' },
          transformResponseBody: null,
        },
      });
    });
  });
});
