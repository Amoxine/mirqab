import { useRef } from 'react';

/**
 * `value` while there is one, and the last one once it is null. A sheet whose content comes from the
 * URL empties the moment it starts closing, while its exit animation still has a few hundred
 * milliseconds to run: this keeps that content on screen until the sheet is gone. Written during render
 * (not in an effect), so the first render for a new value already shows it rather than the previous one.
 */
export function useLastDefined<T>(value: T | null): T | null {
  const last = useRef(value);
  if (value !== null) last.current = value;
  return last.current;
}
