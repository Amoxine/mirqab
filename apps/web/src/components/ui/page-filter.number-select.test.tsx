// @vitest-environment jsdom
// Own file for the same reason as page-filter.select.test.tsx: one Radix Select interaction per file.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PageFilter, type FilterField } from '@open-gateway/ui';

const fields: FilterField[] = [
  {
    type: 'select',
    key: 'minLatencyMs',
    label: 'Latency',
    allLabel: 'Any latency',
    valueType: 'number',
    options: [{ value: '500', label: 'Slower than 500 ms' }],
  },
];

describe('PageFilter numeric select', () => {
  it('turns the chosen string option into a number', async () => {
    const onChange = vi.fn();
    render(
      <PageFilter
        fields={fields}
        values={{}}
        onChange={onChange}
        onReset={vi.fn()}
        labels={{ title: 'Filters', reset: 'Reset', active: (n) => String(n) }}
      />,
    );
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Latency' }), { key: 'ArrowDown' });
    fireEvent.keyDown(await screen.findByRole('option', { name: 'Slower than 500 ms' }), {
      key: 'Enter',
    });
    expect(onChange).toHaveBeenLastCalledWith({ minLatencyMs: 500 });
  });
});
