'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Live `matchMedia(query).matches`. The server snapshot is `false`, so the first client render
 * matches the server HTML and only then updates — no hydration mismatch. Environments without
 * `matchMedia` (jsdom, very old browsers) always report `false`.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => {
        mql.removeEventListener('change', onChange);
      };
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}

/** For JS-driven animation (recharts tweens) that the global CSS reduced-motion rule can't reach. */
export const usePrefersReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)');
