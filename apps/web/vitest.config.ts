import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Only reason this file exists: route handlers import through the `@/` alias tsconfig defines,
 * and vitest does not read tsconfig paths. */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Vite's default esbuild JSX transform is classic (needs `React` in scope); the app relies on
  // Next's own compiler for that, so vitest needs the automatic runtime spelled out itself.
  esbuild: { jsx: 'automatic' },
  test: {
    // Fumadocs' packages import `next/navigation` without the `.js` Node's ESM resolver needs, so they
    // are bundled by vite instead (which also lets a test mock `next/navigation` for them).
    server: { deps: { inline: [/fumadocs-/] } },
    // Runs after every test, jsdom or node — see vitest.setup.ts for why. Without this, renders
    // from one component test leak into the next test's query results (found at WP17 part 1).
    setupFiles: ['./vitest.setup.ts'],
    // Vitest's 5 s default is too tight for a FIRST render of a Radix Sheet/Select in jsdom, and it
    // fails on load, not on a bug. Measured at WP17 (16-core box): the cold first test of each
    // Sheet file costs ~1.2-1.5 s of CPU (SubscribeSheet, with two Selects, ~3 s), most of it jsdom's
    // getComputedStyle rule matching — vitest.setup.ts already removed the part that was ours
    // (injected <style> sheets, ~70 % of one test's profile). Run alone, those tests take 1.4-2.7 s
    // and pass; run as `pnpm test` does, 15 jsdom workers in parallel, they took 5-12 s at a load
    // average of ~50-65 (7-13 of them failed at 5 s; with 16 extra CPU burners on top, 20-25 tests
    // ran past 5 s, worst 12.9 s). 30 s is ~2.3x that worst, and only ever lengthens a test that
    // is genuinely hung, never one that finishes.
    testTimeout: 30_000,
  },
  // Default environment stays 'node' (route/lib tests use real Request/Response and don't need a
  // DOM); component tests opt into jsdom per-file with a `// @vitest-environment jsdom` comment.
});
