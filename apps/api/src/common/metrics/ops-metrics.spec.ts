import { Registry } from 'prom-client';
import { countJobRun, jobRunsTotal, registerOpsCounters, tykNodeLabel } from './ops-metrics';

describe('ops-metrics', () => {
  beforeEach(() => {
    jobRunsTotal.reset();
  });

  const runs = async () =>
    (await jobRunsTotal.get()).values.map(({ labels, value }) => [labels.task, labels.outcome, value]);

  it('countJobRun counts ok and hands back the result', async () => {
    await expect(countJobRun('metering', () => Promise.resolve(3))).resolves.toBe(3);
    expect(await runs()).toEqual([['metering', 'ok', 1]]);
  });

  it('countJobRun counts error and rethrows the same error', async () => {
    const boom = new Error('boom');
    await expect(countJobRun('analytics_retention', () => Promise.reject(boom))).rejects.toBe(boom);
    expect(await runs()).toEqual([['analytics_retention', 'error', 1]]);
  });

  it('names a node by position only', () => {
    expect([0, 1, 2].map(tykNodeLabel)).toEqual(['tyk-1', 'tyk-2', 'tyk-3']);
  });

  it('seeds every label set at 0 so increase() sees the first failure', async () => {
    const registry = new Registry();
    registerOpsCounters(registry, 3);
    const text = await registry.metrics();

    expect(text).toContain('og_tyk_fanout_total{node="tyk-3",operation="reloadAllNodes",outcome="error"} 0');
    expect(text).toContain('og_job_runs_total{task="key_expiry",outcome="error"} 0');
    expect(text).toContain('og_authz_denied_total{reason="no_tenant"} 0');
    // The request-search indexer and its upkeep are listed jobs, seeded like the rest, so their first failure alerts.
    expect(text).toContain('og_job_runs_total{task="search_index",outcome="error"} 0');
    expect(text).toContain('og_job_runs_total{task="search_maintenance",outcome="error"} 0');
    expect(text).toContain('og_traffic_search_skipped_rows_total 0');
    expect(text).toContain('og_traffic_search_maintenance_failures_total{phase="partition_drop"} 0');
    expect(text).toContain('# TYPE og_traffic_search_indexed_age_seconds gauge');
    // 3 nodes × 13 operations × 3 outcomes: the fan-out counter's whole cardinality.
    expect(text.match(/^og_tyk_fanout_total\{/gm)).toHaveLength(117);
  });
});
