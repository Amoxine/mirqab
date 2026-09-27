import { Counter, type Registry } from 'prom-client';

/**
 * Counters bumped from code that `ObservabilityModule` itself depends on — the Tyk client, the
 * schedulers, the guards on every controller — so none of it can inject `MetricsService` without a
 * module cycle. They are plain module-level metrics created UNREGISTERED; `registerOpsCounters` puts
 * them on the `/api/metrics` registry.
 *
 * Every label value comes from a closed list below. No tenant, user, route or URL is ever a label.
 */

/** Every `TykClientService` method that fans out to the nodes (TYK-04). */
export const TYK_FANOUT_OPERATIONS = [
  'upsertOasApi',
  'deleteOasApi',
  'upsertMcp',
  'deleteMcp',
  'invalidateCache',
  'createApi',
  'updateApi',
  'deleteApi',
  'upsertPolicy',
  'deletePolicy',
  'setOrgSession',
  'deleteOrgSession',
  'reloadAllNodes',
] as const;
export type TykFanoutOperation = (typeof TYK_FANOUT_OPERATIONS)[number];

export const TYK_FANOUT_OUTCOMES = ['ok', 'error', 'circuit_open'] as const;
export type TykFanoutOutcome = (typeof TYK_FANOUT_OUTCOMES)[number];

/** A node's position in `TYK_ADMIN_URLS`, never its URL: the URL is deployment detail at best. */
export const tykNodeLabel = (index: number): string => `tyk-${String(index + 1)}`;

export const tykFanoutTotal = new Counter({
  name: 'og_tyk_fanout_total',
  help: 'Per-node outcome of each Tyk fan-out write (TYK-04)',
  labelNames: ['node', 'operation', 'outcome'] as const,
  registers: [],
});

/**
 * Every `@Cron` / `@Interval` job in the API (APP-06). The label is `task`, not `job`: Prometheus owns
 * `job` (and `instance`) on every scraped series, and a clashing label is renamed `exported_job`.
 */
export const JOBS = [
  'reconcile',
  'health_check',
  'metering',
  'quota_reset',
  'key_expiry',
  'analytics_retention',
  'spec_source_fetch',
] as const;
export type JobName = (typeof JOBS)[number];

export const jobRunsTotal = new Counter({
  name: 'og_job_runs_total',
  help: 'Scheduled job runs by outcome (APP-06)',
  labelNames: ['task', 'outcome'] as const,
  registers: [],
});

export function recordJobRun(job: JobName, ok: boolean): void {
  jobRunsTotal.inc({ task: job, outcome: ok ? 'ok' : 'error' });
}

/** Counts one run: resolving is `ok`, throwing is `error`. The error is rethrown untouched. */
export async function countJobRun<T>(job: JobName, run: () => Promise<T>): Promise<T> {
  let ok = false;
  try {
    const result = await run();
    ok = true;
    return result;
  } finally {
    recordJobRun(job, ok);
  }
}

export const AUTHZ_DENIAL_REASONS = ['tenant_mismatch', 'missing_permission', 'no_tenant'] as const;
export type AuthzDenialReason = (typeof AUTHZ_DENIAL_REASONS)[number];

export const authzDeniedTotal = new Counter({
  name: 'og_authz_denied_total',
  help: 'Requests refused by TenantIsolationGuard or PermissionsGuard, by reason (APP-07)',
  labelNames: ['reason'] as const,
  registers: [],
});

/**
 * Register the counters and seed every label set at 0. The seed is what makes the alerts work:
 * `increase()` over a series that first appears at 1 reads 0, so without it the FIRST failure of a
 * job or a node would never fire AL-APP-06 / AL-TYK-04.
 */
export function registerOpsCounters(registry: Registry, nodeCount: number): void {
  registry.registerMetric(tykFanoutTotal);
  registry.registerMetric(jobRunsTotal);
  registry.registerMetric(authzDeniedTotal);

  for (let index = 0; index < nodeCount; index++) {
    for (const operation of TYK_FANOUT_OPERATIONS) {
      for (const outcome of TYK_FANOUT_OUTCOMES) {
        tykFanoutTotal.inc({ node: tykNodeLabel(index), operation, outcome }, 0);
      }
    }
  }
  for (const job of JOBS) {
    jobRunsTotal.inc({ task: job, outcome: 'ok' }, 0);
    jobRunsTotal.inc({ task: job, outcome: 'error' }, 0);
  }
  for (const reason of AUTHZ_DENIAL_REASONS) authzDeniedTotal.inc({ reason }, 0);
}
