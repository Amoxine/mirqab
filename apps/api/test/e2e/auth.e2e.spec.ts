import { test, expect } from '@playwright/test';

/**
 * This suite originally covered login, logout, refresh/expiry, register→tenant-less 403,
 * cross-tenant 403 and a permission-gated route, ported from the scratchpad Playwright scripts
 * against apps/api's own auth.controller.ts (email/password login, cookie refresh rotation, etc.).
 *
 * Mid-implementation, a concurrent workstream in this same wave (Ory Hydra/Kratos cutover) removed
 * that entire local surface: AuthController is now just `GET /auth/me` reading a Hydra-issued token
 * — login/register/refresh/logout moved to Kratos + Hydra, driven from apps/web (WP3), which this
 * API-only (`@playwright/test` `request` fixture, no browser) suite has no way to exercise. Re-adding
 * the six flows above belongs with that work once there is a Kratos/Hydra stack to drive against —
 * see the plan's WP3/WP7.
 *
 * What is still this API's own invariant, and still worth a real-process check (not just the
 * synthetic module in src/app.module.spec.ts): the global JwtAuthGuard (app.module.ts) actually
 * protects a real route with no token, end to end, in the compiled binary.
 */
test('GET /auth/me requires a session — no cookie, no bearer token, no access', async ({ request }) => {
  const res = await request.get('auth/me');
  expect(res.status()).toBe(401);
});
