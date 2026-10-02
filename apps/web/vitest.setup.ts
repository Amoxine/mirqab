import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

/** Every component test opts into jsdom per-file (`// @vitest-environment jsdom`); this file
 * runs for all of them regardless. `cleanup()` unmounts and clears the document after each test —
 * without it, renders from an earlier test stay mounted and the next query can match elements
 * that belong to a previous test, not the current one. A no-op for lib/route tests that never
 * render anything. */
afterEach(() => {
  cleanup();
});

/** `waitFor` and every `findBy*` give up after 1 s by default. That is tight for the first render of a
 * Radix Sheet or Select in jsdom, and for any test in a 15-worker run on a busy machine: several suites
 * passed 8000 ms to each call, and the ones that did not were the ones that flaked under load. It only
 * ever lengthens a wait for something that is going to appear; a test that waits for something that
 * never does still fails, 8 s later. */
configure({ asyncUtilTimeout: 8000 });

// Libraries inject runtime <style> tags into <head>: `sonner` a ~15 KB / 97-rule sheet the moment it
// is IMPORTED (every Sheet/Dialog test imports it — each form toasts on save), and
// react-remove-scroll-bar (Radix Dialog/Select scroll lock) whenever one opens. jsdom's
// getComputedStyle then matches EVERY rule of EVERY sheet against the element on EVERY call, and
// Radix Presence, floating-ui, and Testing Library's getByRole (isInaccessible + accessible name)
// call it constantly. Profiled at WP17 (in-process CPU profile of one cold Sheet test): 6.5 s ->
// 2.0 s once these sheets stopped attaching; before, jsdom computed-style `handleRule` ->
// @asamuzakjp/dom-selector rule matching was ~3 s of it. That is what pushed the first test of each
// Sheet file past the 5 s default whenever workers were contended. These tests load no app CSS and
// jsdom lays nothing out, so every <style> reaching
// <head> is one of those injected sheets and nothing reads what it says; not attaching them
// changes no behaviour, only the cost of every style lookup. Both libraries insert with
// `document.head.appendChild`, so intercepting that covers import-time and open-time injection alike.
// `document` is undefined in the node-environment (route/lib) tests, which have no head to guard.
// This file sits outside tsconfig's `include` (src only), so typed linting cannot resolve DOM types
// in it — the same reason the two shims below carry disables; scoped to just this block.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
if (typeof document !== 'undefined') {
  const head = document.head;
  const appendToHead = head.appendChild.bind(head);
  head.appendChild = ((node: Node) =>
    node instanceof HTMLStyleElement ? node : appendToHead(node)) as typeof head.appendChild;
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */

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
