// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChipInput, type ChipInputChip } from '@open-gateway/ui';

const labels = {
  input: 'Search filters',
  placeholder: 'status:>=500',
  remove: (text: string) => `Remove ${text}`,
  edit: (text: string) => `Edit ${text}`,
};
const chips: ChipInputChip[] = [
  { id: 'a', text: 'status:>=500' },
  { id: 'b', text: '-status:404', tone: 'negated' },
];

function setup(list: ChipInputChip[] = chips) {
  const onSubmit = vi.fn();
  const onRemove = vi.fn();
  render(<ChipInput chips={list} onSubmit={onSubmit} onRemove={onRemove} labels={labels} describedBy="why" />);
  return { onSubmit, onRemove, input: screen.getByLabelText<HTMLInputElement>('Search filters') };
}

describe('ChipInput', () => {
  it('submits the typed text on Enter and clears the field', () => {
    const { onSubmit, input } = setup();
    fireEvent.change(input, { target: { value: 'method:POST' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('method:POST');
    expect(input.value).toBe('');
  });

  it('ignores Enter on blank text, and Enter that confirms an IME composition', () => {
    const { onSubmit, input } = setup();
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'かな' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input.value).toBe('かな');
  });

  it('removes the last chip on Backspace in an empty field, but not while text is being deleted', () => {
    const { onRemove, input } = setup();
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onRemove).toHaveBeenCalledWith('b');
  });

  it('removes a chip with its button', () => {
    const { onRemove } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Remove status:>=500' }));
    expect(onRemove).toHaveBeenCalledWith('a');
  });

  it('moves a chip back into the field to edit it', () => {
    const { onRemove, input } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit -status:404' }));
    expect(onRemove).toHaveBeenCalledWith('b');
    expect(input.value).toBe('-status:404');
  });

  it('shows the placeholder only while there are no chips, and points at its explanation', () => {
    const empty = setup([]);
    expect(empty.input.placeholder).toBe('status:>=500');
    expect(empty.input.getAttribute('aria-describedby')).toBe('why');
  });

  it('hides the placeholder once there are chips', () => {
    const { input } = setup();
    expect(input.placeholder).toBe('');
  });
});
