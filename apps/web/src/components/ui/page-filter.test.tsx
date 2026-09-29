// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PageFilter, countActiveFilters, type FilterField } from '@open-gateway/ui';

afterEach(() => {
  vi.useRealTimers();
});

const labels = {
  title: 'Filters',
  reset: 'Reset filters',
  active: (count: number) => `${String(count)} active`,
};

const range: FilterField = {
  type: 'segmented',
  key: 'range',
  label: 'Time range',
  options: [
    { value: '24h', label: '24h' },
    { value: '7d', label: '7d' },
  ],
};
const query: FilterField = { type: 'search', key: 'q', label: 'Search', debounceMs: 300 };
const status: FilterField = { type: 'number', key: 'status', label: 'Status', min: 100, max: 599 };
const from: FilterField = { type: 'date', key: 'from', label: 'From' };

function setup(
  fields: FilterField[],
  values: Record<string, string | number | undefined>,
  layout?: 'card' | 'inline' | 'popover',
) {
  const onChange = vi.fn();
  const onReset = vi.fn();
  const view = render(
    <PageFilter
      fields={fields}
      values={values}
      onChange={onChange}
      onReset={onReset}
      labels={labels}
      layout={layout}
    />,
  );
  return { onChange, onReset, ...view };
}

describe('countActiveFilters', () => {
  it('ignores segmented fields (a range always applies) and empty values', () => {
    expect(
      countActiveFilters([range, query, status], { range: '7d', q: 'abc', status: undefined }),
    ).toBe(1);
    expect(countActiveFilters([query], { q: '' })).toBe(0);
    // countAsFilter overrides the default either way
    expect(countActiveFilters([{ ...query, countAsFilter: false }], { q: 'x' })).toBe(0);
  });
});

describe('PageFilter (card)', () => {
  it('shows how many filters are active and resets them; Reset is disabled at zero', () => {
    const active = setup([range, query], { range: '24h', q: 'abc' });
    expect(screen.getByRole('status').textContent).toBe('1 active');
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(active.onReset).toHaveBeenCalledTimes(1);
    active.unmount();

    setup([range, query], { range: '24h' });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reset filters' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('is a search landmark named after labels.title', () => {
    setup([query], {});
    expect(screen.getByRole('search', { name: 'Filters' })).toBeTruthy();
  });

  it('debounces a search box, trims empty to undefined, and re-syncs to an external change', () => {
    vi.useFakeTimers();
    const { onChange, rerender } = setup([query], {});
    const input = screen.getByLabelText<HTMLInputElement>('Search');

    fireEvent.change(input, { target: { value: 'or' } });
    fireEvent.change(input, { target: { value: 'ord' } });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ q: 'ord' });

    fireEvent.change(input, { target: { value: '   ' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onChange).toHaveBeenLastCalledWith({ q: undefined });

    // The parent changes the value (Reset, browser back): the box follows.
    rerender(
      <PageFilter
        fields={[query]}
        values={{ q: 'from-url' }}
        onChange={onChange}
        onReset={vi.fn()}
        labels={labels}
      />,
    );
    expect(input.value).toBe('from-url');
  });

  it('Reset discards an uncommitted draft instead of re-applying it later', () => {
    vi.useFakeTimers();
    const { onChange, onReset } = setup([query, from], { from: '2026-09-01' });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(onReset).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>('Search').value).toBe('');
  });

  it('fires on every keystroke when debounceMs is 0 (client-side filtering)', () => {
    const { onChange } = setup([{ ...query, debounceMs: 0 }], {});
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'a' } });
    expect(onChange).toHaveBeenLastCalledWith({ q: 'a' });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'ab' } });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('accepts digits only in a number field and emits undefined outside min..max', () => {
    vi.useFakeTimers();
    const { onChange } = setup([status], {});
    const input = screen.getByLabelText<HTMLInputElement>('Status');

    fireEvent.change(input, { target: { value: '4a0b4x' } });
    expect(input.value).toBe('404'); // letters stripped, capped at max's 3 digits
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(onChange).toHaveBeenLastCalledWith({ status: 404 });

    fireEvent.change(input, { target: { value: '99' } });
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(onChange).toHaveBeenLastCalledWith({ status: undefined });
  });

  it('never deselects a segmented field: pressing the active item is ignored', () => {
    const { onChange } = setup([range], { range: '24h' });
    fireEvent.click(screen.getByRole('radio', { name: '24h' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: '7d' }));
    expect(onChange).toHaveBeenCalledWith({ range: '7d' });
  });

  it('reports a date, and clears it with undefined', () => {
    const empty = setup([from], {});
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });
    expect(empty.onChange).toHaveBeenLastCalledWith({ from: '2026-09-01' });
    empty.unmount();

    // Controlled: clearing is a change only when the parent's value was set.
    const set = setup([from], { from: '2026-09-01' });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '' } });
    expect(set.onChange).toHaveBeenLastCalledWith({ from: undefined });
  });
});

describe('PageFilter (inline)', () => {
  it('shows Reset only while something is active', () => {
    const idle = setup([query], {}, 'inline');
    expect(screen.queryByRole('button', { name: 'Reset filters' })).toBeNull();
    idle.unmount();

    setup([query], { q: 'x' }, 'inline');
    expect(screen.getByRole('button', { name: 'Reset filters' })).toBeTruthy();
  });
});

describe('PageFilter (popover)', () => {
  it('puts the fields behind a button that carries the active count', () => {
    setup([query, from], { q: 'x', from: '2026-09-01' }, 'popover');
    const trigger = screen.getByRole('button', { name: /Filters/ });
    expect(trigger.textContent).toContain('2');
    expect(screen.queryByLabelText('Search')).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByLabelText('Search')).toBeTruthy();
    expect(screen.getByLabelText('From')).toBeTruthy();
  });

  it('commits a typed-but-pending search when the popover closes', () => {
    const { onChange } = setup([query], {}, 'popover');
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'abc' } });
    fireEvent.keyDown(screen.getByLabelText('Search'), { key: 'Escape' });
    expect(onChange).toHaveBeenCalledWith({ q: 'abc' });
  });
});
