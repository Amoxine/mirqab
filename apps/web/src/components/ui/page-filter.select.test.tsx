// @vitest-environment jsdom
// Kept in its own file: a Radix Select left open by an earlier test in the same file breaks the next
// one (see endpoints-tab.tag.test.tsx), so every Select interaction lives here.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PageFilter, type FilterField } from '@open-gateway/ui';

const labels = { title: 'Filters', reset: 'Reset', active: (n: number) => `${String(n)} active` };

const fields: FilterField[] = [
  {
    type: 'select',
    key: 'method',
    label: 'Method',
    allLabel: 'All methods',
    options: [
      { value: 'GET', label: 'GET' },
      { value: 'POST', label: 'POST' },
    ],
  },
];

describe('PageFilter select fields', () => {
  it('hides the ALL sentinel, emits undefined for "all"', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PageFilter
        fields={fields}
        values={{}}
        onChange={onChange}
        onReset={vi.fn()}
        labels={labels}
      />,
    );

    // No value: the trigger shows the "all" text, not the internal sentinel.
    expect(screen.getByRole('combobox', { name: 'Method' }).textContent).toBe('All methods');

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Method' }), { key: 'ArrowDown' });
    fireEvent.keyDown(await screen.findByRole('option', { name: 'POST' }), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith({ method: 'POST' });

    // Controlled: the parent applies the value, the trigger follows it.
    rerender(
      <PageFilter
        fields={fields}
        values={{ method: 'POST' }}
        onChange={onChange}
        onReset={vi.fn()}
        labels={labels}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Method' }).textContent).toBe('POST');
    });

    // Choosing "all" clears the field — undefined, never '__all__'.
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Method' }), { key: 'ArrowDown' });
    fireEvent.keyDown(await screen.findByRole('option', { name: 'All methods' }), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith({ method: undefined });
  });
});
