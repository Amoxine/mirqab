// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apisMessages from '@/messages/en/apis.json';
import commonMessages from '@/messages/en/common.json';
import { baseApi, wrap } from './test-utils';
import { DetailedRecordingSheet } from './detailed-recording-sheet';

const M = apisMessages;

const mutateAsync = vi.fn().mockResolvedValue(undefined);
vi.mock('@/hooks/use-apis', () => ({
  useUpdateApi: () => ({ mutateAsync }),
}));

describe('DetailedRecordingSheet', () => {
  it('defaults to off and toggles to true on save', async () => {
    render(wrap(<DetailedRecordingSheet api={baseApi} open onOpenChange={() => undefined} />));

    const toggle = screen.getByLabelText(M.designer.detailedRecording.enable);
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: commonMessages.save }));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({ config: { detailedRecording: true } });
    });
  });
});
