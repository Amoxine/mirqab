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
    // Runs after every test, jsdom or node — see vitest.setup.ts for why. Without this, renders
    // from one component test leak into the next test's query results (found at WP17 part 1).
    setupFiles: ['./vitest.setup.ts'],
  },
  // Default environment stays 'node' (route/lib tests use real Request/Response and don't need a
  // DOM); component tests opt into jsdom per-file with a `// @vitest-environment jsdom` comment.
});
