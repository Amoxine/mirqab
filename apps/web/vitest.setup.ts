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

// jsdom has no ResizeObserver, but @radix-ui/react-switch (and -select) call it on mount to size
// their thumb/viewport — without a stub, mounting either in a jsdom test throws
// "ResizeObserver is not defined" (found at WP17 part 2). A no-op is enough: these tests assert
// behaviour, not layout. `globalThis`, not `window`, so node-environment tests are unaffected either way.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver implements ResizeObserver {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- deliberate no-op stub, see comment above
    observe() {}
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- deliberate no-op stub, see comment above
    unobserve() {}
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- deliberate no-op stub, see comment above
    disconnect() {}
  }
  globalThis.ResizeObserver = NoopResizeObserver;
}

// jsdom also has no scrollIntoView — @radix-ui/react-select calls it on the selected item when its
// content mounts, which otherwise throws "scrollIntoView is not a function" (WP17 part 2). This
// file's tsconfig has no DOM lib, so `Element` type-checks as `unknown` here — the two lines below
// are the only ones that touch it.
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- see comment above
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-empty-function -- see comment above
  Element.prototype.scrollIntoView = () => {};
}
