import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/** Every component test opts into jsdom per-file (`// @vitest-environment jsdom`); this file
 * runs for all of them regardless. `cleanup()` unmounts and clears the document after each test —
 * without it, renders from an earlier test stay mounted and the next query can match elements
 * that belong to a previous test, not the current one. A no-op for lib/route tests that never
 * render anything. */
afterEach(() => {
  cleanup();
});
