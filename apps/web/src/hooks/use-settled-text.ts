import { useEffect, useState } from 'react';

/**
 * The text for a live region that should speak only about a settled result. While `settled` is false
 * (a changed filter is still loading and the old rows are still shown, or a fetch failed) it keeps its
 * last words, so nothing stale or half-loaded is announced; when it settles it takes the new text, and
 * a screen reader announces it only if that text actually differs. It starts empty, so the first
 * result is an addition to the region rather than something already there when it appeared.
 */
export function useSettledText(text: string, settled: boolean): string {
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (settled) setSaid(text);
  }, [settled, text]);
  return said;
}
