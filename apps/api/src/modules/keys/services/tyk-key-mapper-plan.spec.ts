import { BadRequestException } from '@nestjs/common';
import { QuotaPeriod } from '@prisma/client';
import { buildTykKeyDef } from './tyk-key-mapper';

/**
 * WP18's key-side acceptance: a key with a plan carries `apply_policies` and NO inline limits.
 *
 * That exclusivity is the feature, not tidiness. Tyk lets an inline `rate` on the session win over
 * the policy's, so a key that kept its own limits would silently ignore every plan edit — exactly
 * the behaviour plans exist to replace.
 */
const PLAN_ID = '22222222-2222-4222-8222-222222222222';
const apiDef = { name: 'Orders', tykApiId: 'og-orders' };

describe('buildTykKeyDef — plan-backed keys (WP18)', () => {
  it('carries apply_policies:[planId] and no inline rate or quota', () => {
    const def = buildTykKeyDef({ name: 'k', planId: PLAN_ID }, apiDef, 'og-tenant');

    expect(def.apply_policies).toEqual([PLAN_ID]);
    expect(def).not.toHaveProperty('rate');
    expect(def).not.toHaveProperty('per');
    expect(def).not.toHaveProperty('quota_max');
    expect(def).not.toHaveProperty('quota_renewal_rate');
  });

  it('still scopes the key to its API — a plan grants limits, not access', () => {
    const def = buildTykKeyDef({ name: 'k', planId: PLAN_ID }, apiDef, 'og-tenant');
    expect(def.access_rights).toEqual({
      'og-orders': { api_id: 'og-orders', api_name: 'Orders', versions: ['Default'] },
    });
  });

  it.each([
    ['rateLimitPerSecond', { rateLimitPerSecond: 5 }],
    ['quotaLimit', { quotaLimit: 100, quotaPeriod: QuotaPeriod.DAILY }],
  ])('refuses planId together with %s rather than silently picking a winner', (_label, limits) => {
    expect(() => buildTykKeyDef({ name: 'k', planId: PLAN_ID, ...limits }, apiDef, 'og-tenant')).toThrow(
      BadRequestException,
    );
  });

  it('leaves the pre-WP18 inline path untouched when there is no plan', () => {
    const def = buildTykKeyDef(
      { name: 'k', rateLimitPerSecond: 5, quotaLimit: 100, quotaPeriod: QuotaPeriod.DAILY },
      apiDef,
      'og-tenant',
      1_000_000,
    );

    expect(def).not.toHaveProperty('apply_policies');
    expect(def).toMatchObject({
      rate: 5,
      per: 1,
      quota_max: 100,
      quota_renewal_rate: 86_400,
      quota_renews: 1_086_400,
    });
  });

  it('treats a null planId as "no plan", not as a plan', () => {
    const def = buildTykKeyDef({ name: 'k', planId: null, rateLimitPerSecond: 5 }, apiDef, 'og-tenant');
    expect(def).not.toHaveProperty('apply_policies');
    expect(def.rate).toBe(5);
  });
});
