// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSettledText } from './use-settled-text';

describe('useSettledText', () => {
  it('says nothing until the first result has settled', () => {
    const { result, rerender } = renderHook(({ text, settled }) => useSettledText(text, settled), {
      initialProps: { text: 'No requests', settled: false },
    });
    expect(result.current).toBe('');
    rerender({ text: '12 requests', settled: true });
    expect(result.current).toBe('12 requests');
  });

  it('keeps its last words while the next result is still loading, then says the new ones', () => {
    const { result, rerender } = renderHook(({ text, settled }) => useSettledText(text, settled), {
      initialProps: { text: '12 requests', settled: true },
    });
    rerender({ text: '3 requests', settled: false });
    expect(result.current).toBe('12 requests');
    rerender({ text: '3 requests', settled: true });
    expect(result.current).toBe('3 requests');
  });

  it('returns the same text while nothing changed, so there is nothing new to announce', () => {
    const { result, rerender } = renderHook(({ text, settled }) => useSettledText(text, settled), {
      initialProps: { text: '12 requests', settled: true },
    });
    const first = result.current;
    rerender({ text: '12 requests', settled: true });
    expect(result.current).toBe(first);
  });
});
