import { QuotaPeriod } from '@prisma/client';
import { buildPlanPolicy } from './plan-policy';

const plan = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Gold',
  rate: 10,
  per: 1,
  quotaMax: 1_000_000,
  quotaPeriod: QuotaPeriod.MONTHLY,
  active: true,
};

describe('buildPlanPolicy', () => {
  it('uses the plan id AS the policy id, so apply_policies:[planId] is literally true', () => {
    expect(buildPlanPolicy(plan, 'og-tenant').id).toBe(plan.id);
  });

  it('carries the tenant org, so one tenant’s plan is never another’s', () => {
    expect(buildPlanPolicy(plan, 'og-tenant').org_id).toBe('og-tenant');
  });

  it('maps rate and quota straight through when they are set', () => {
    const policy = buildPlanPolicy(plan, 'og-tenant');
    expect(policy).toMatchObject({
      rate: 10,
      per: 1,
      quota_max: 1_000_000,
      quota_renewal_rate: 2_592_000, // MONTHLY
      active: true,
      state: 'active',
    });
  });

  /**
   * The two inverted conventions. Getting either backwards produces a policy Tyk accepts and then
   * enforces as a total block, which is why they get their own tests rather than a comment.
   */
  it('treats rate 0 as NO rate limit, zeroing `per` with it', () => {
    const policy = buildPlanPolicy({ ...plan, rate: 0 }, 'og-tenant');
    expect(policy.rate).toBe(0);
    // per must be 0 too: rate 0 with a non-zero window reads as "0 requests per second".
    expect(policy.per).toBe(0);
  });

  it('treats quotaMax -1 as unlimited and stops sending a renewal rate', () => {
    const policy = buildPlanPolicy({ ...plan, quotaMax: -1 }, 'og-tenant');
    expect(policy.quota_max).toBe(-1);
    expect(policy.quota_renewal_rate).toBe(0);
  });

  it('keeps quotaMax 0 as zero — it is a real quota of nothing, not "unlimited"', () => {
    expect(buildPlanPolicy({ ...plan, quotaMax: 0 }, 'og-tenant').quota_max).toBe(0);
  });

  it('marks an inactive plan draft, so the gateway stops applying it', () => {
    const policy = buildPlanPolicy({ ...plan, active: false }, 'og-tenant');
    expect(policy).toMatchObject({ active: false, state: 'draft' });
  });

  it('grants no access rights of its own — a plan is a limit tier, not a grant of APIs', () => {
    expect(buildPlanPolicy(plan, 'og-tenant').access_rights).toEqual({});
  });

  it.each([
    [QuotaPeriod.HOURLY, 3600],
    [QuotaPeriod.DAILY, 86_400],
    [QuotaPeriod.WEEKLY, 604_800],
    [QuotaPeriod.MONTHLY, 2_592_000],
  ])('maps %s to %i seconds', (period, seconds) => {
    expect(buildPlanPolicy({ ...plan, quotaPeriod: period }, 'og').quota_renewal_rate).toBe(seconds);
  });
});
