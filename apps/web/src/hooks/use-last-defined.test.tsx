// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLastDefined } from './use-last-defined';

describe('useLastDefined', () => {
  it('is the value while there is one', () => {
    const { result } = renderHook(({ value }) => useLastDefined(value), { initialProps: { value: 'a' as string | null } });
    expect(result.current).toBe('a');
  });

  it('keeps the last value once it goes away, so a panel closing still has its content to show', () => {
    const { result, rerender } = renderHook(({ value }) => useLastDefined(value), { initialProps: { value: 'a' as string | null } });
    rerender({ value: null });
    expect(result.current).toBe('a');
  });

  it('takes a new value at once, with no render showing the old one', () => {
    const seen: (string | null)[] = [];
    const { rerender } = renderHook(
      ({ value }) => {
        const shown = useLastDefined(value);
        seen.push(shown);
        return shown;
      },
      { initialProps: { value: 'a' as string | null } },
    );
    rerender({ value: null });
    rerender({ value: 'b' });
    expect(seen.at(-1)).toBe('b');
    expect(seen.filter((v) => v === 'a').length).toBe(2);
  });

  it('is null until there has ever been a value', () => {
    const { result } = renderHook(() => useLastDefined<string>(null));
    expect(result.current).toBeNull();
  });
});
