import { defineConfig } from '@playwright/test';

// A distinct port from the dev default (33001, see .env.example) so a locally running dev server is
// never mistaken for (or collides with) the throwaway instance these tests boot.
const PORT = 33091;
const HOST = `http://127.0.0.1:${PORT}`;

/**
 * API-only auth regression suite (no browser) — see test/e2e/auth.e2e.spec.ts for what this covers
 * and why it's smaller than originally scoped. Needs a real Postgres + Redis (`pnpm db:migrate`); it
 * boots the compiled API itself via `webServer` below.
 */
export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.e2e.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    // Trailing slash matters: Playwright resolves a request path against baseURL the way
    // `new URL(path, baseURL)` does, so a LEADING slash in a test's path (e.g. '/auth/login')
    // resolves against the origin and silently drops '/api'. Paths in tests must be relative
    // (no leading slash — 'auth/login', not '/auth/login') for that reason.
    baseURL: `${HOST}/api/`,
  },
  webServer: {
    command: 'node dist/main.js',
    url: `${HOST}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { ...process.env, PORT: String(PORT) },
  },
});
