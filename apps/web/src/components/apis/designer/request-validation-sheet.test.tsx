// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apisMessages from '@/messages/en/apis.json';
import commonMessages from '@/messages/en/common.json';
import { baseApi, wrap } from './test-utils';
import { RequestValidationSheet } from './request-validation-sheet';

const M = apisMessages;

const mutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/use-apis', () => ({
  useUpdateApi: () => ({ mutateAsync }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RequestValidationSheet', () => {
  it('parses valid JSON into the schema object', async () => {
    render(wrap(<RequestValidationSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.change(screen.getByLabelText(M.designer.requestValidation.schema), {
      target: { value: '{"type":"object","required":["id"]}' },
    });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        config: { validateRequestSchema: { type: 'object', required: ['id'] } },
      });
    });
  });

  it('rejects malformed JSON instead of sending it', async () => {
    render(wrap(<RequestValidationSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.change(screen.getByLabelText(M.designer.requestValidation.schema), { target: { value: '{not json' } });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    expect(await screen.findByText(M.designer.requestValidation.invalidJson)).toBeDefined();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('rejects a JSON array — a schema must be an object', async () => {
    render(wrap(<RequestValidationSheet api={baseApi} open onOpenChange={() => undefined} />));

    fireEvent.change(screen.getByLabelText(M.designer.requestValidation.schema), { target: { value: '[1,2]' } });
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    expect(await screen.findByText(M.designer.requestValidation.mustBeObject)).toBeDefined();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
