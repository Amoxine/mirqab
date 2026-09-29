'use client';

import { useMediaQuery } from '@open-gateway/ui';

export { useMediaQuery };

/** For JS-driven animation (recharts tweens) that the global CSS reduced-motion rule can't reach. */
export const usePrefersReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)');
