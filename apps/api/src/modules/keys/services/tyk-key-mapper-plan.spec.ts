import { BadRequestException } from '@nestjs/common';
import { QuotaPeriod } from '@prisma/client';
import { buildTykKeyDef, buildKeyAclPolicy } from './tyk-key-mapper';

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

/**
 * WP18 fix: a plan's own policy is deliberately ACL-less (`buildPlanPolicy`'s `partitions.acl:
 * false`), so `apply_policies:[planId]` alone fails at `/tyk/keys/create` — live-verified against
 * Tyk 5.15.0, "key has no valid policies to be applied". A second, per-key ACL-owning policy fixes
 * it without giving the plan itself any access grant.
 */
describe('buildTykKeyDef — with an ACL policy id (WP18 fix)', () => {
  it('applies both the plan and the ACL policy, in that order', () => {
    const def = buildTykKeyDef({ name: 'k', planId: PLAN_ID }, apiDef, 'og-tenant', undefined, 'acl-policy-1');
    expect(def.apply_policies).toEqual([PLAN_ID, 'acl-policy-1']);
  });

  it('is a no-op for a non-plan key — an ACL policy id with no planId changes nothing', () => {
    const def = buildTykKeyDef({ name: 'k', rateLimitPerSecond: 5 }, apiDef, 'og-tenant', 1_000_000, 'acl-policy-1');
    expect(def).not.toHaveProperty('apply_policies');
    expect(def.rate).toBe(5);
  });
});

describe('buildKeyAclPolicy', () => {
  it('owns ACL only — real access rights, no rate/quota partition', () => {
    const policy = buildKeyAclPolicy('acl-policy-1', apiDef, 'og-tenant');

    expect(policy).toMatchObject({
      id: 'acl-policy-1',
      org_id: 'og-tenant',
      active: true,
      access_rights: { 'og-orders': { api_id: 'og-orders', api_name: 'Orders', versions: ['Default'] } },
      partitions: { quota: false, rate_limit: false, acl: true, complexity: false, per_api: false },
    });
  });

  it('is null when there is nothing to grant — no API, no policy needed', () => {
    expect(buildKeyAclPolicy('acl-policy-1', null, 'og-tenant')).toBeNull();
    expect(buildKeyAclPolicy('acl-policy-1', { name: 'x', tykApiId: null }, 'og-tenant')).toBeNull();
  });

  it('grants every API in an array (WP22: a portal subscription bundles a whole Product)', () => {
    const orders = { name: 'Orders', tykApiId: 'og-orders' };
    const invoices = { name: 'Invoices', tykApiId: 'og-invoices' };

    const policy = buildKeyAclPolicy('acl-policy-1', [orders, invoices], 'og-tenant');

    expect(policy?.access_rights).toEqual({
      'og-orders': { api_id: 'og-orders', api_name: 'Orders', versions: ['Default'] },
      'og-invoices': { api_id: 'og-invoices', api_name: 'Invoices', versions: ['Default'] },
    });
  });

  it('drops an API with no tykApiId from the array rather than failing the whole grant', () => {
    const synced = { name: 'Orders', tykApiId: 'og-orders' };
    const unsynced = { name: 'Draft API', tykApiId: null };

    const policy = buildKeyAclPolicy('acl-policy-1', [synced, unsynced], 'og-tenant');

    expect(Object.keys(policy?.access_rights as object)).toEqual(['og-orders']);
  });

  it('is null for an empty array — same as no API at all', () => {
    expect(buildKeyAclPolicy('acl-policy-1', [], 'og-tenant')).toBeNull();
  });
});
