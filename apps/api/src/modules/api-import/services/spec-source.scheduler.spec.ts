import { Logger } from '@nestjs/common';
import { Registry } from 'prom-client';
import type { ApiSpecSource } from '@prisma/client';
import type { MetricsService } from '../../observability/metrics.service';
import { roundRobinByTenant, SPEC_CHECK_TICK_BUDGET_MS, SpecSourceScheduler, tenantShareMs } from './spec-source.scheduler';
import type { SpecSourceService } from './spec-source.service';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

const NOW = new Date('2026-09-25T12:00:00.000Z');
const due = (id: string, tenantId: string, overdueSeconds = 0): ApiSpecSource =>
  ({ id, tenantId, nextCheckAt: new Date(NOW.getTime() - overdueSeconds * 1000) }) as ApiSpecSource;

function setup(rows: ApiSpecSource[]) {
  const registry = new Registry();
  const sources = {
    due: jest.fn().mockResolvedValue({ now: NOW, sources: rows }),
    claimAndCheck: jest.fn().mockResolvedValue(null),
  };
  const scheduler = new SpecSourceScheduler(sources as unknown as SpecSourceService, { registry } as unknown as MetricsService);
  return { scheduler, sources, registry };
}

beforeAll(() => {
  Logger.overrideLogger(false);
});

describe('roundRobinByTenant', () => {
  it('interleaves tenants, keeping each tenant’s own order', () => {
    const rows = [due('a1', 'A'), due('a2', 'A'), due('a3', 'A'), due('b1', 'B'), due('c1', 'C'), due('b2', 'B')];
    expect(roundRobinByTenant(rows).map((r) => r.id)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
  });

  it('handles nothing', () => {
    expect(roundRobinByTenant([])).toEqual([]);
  });
});

describe('SpecSourceScheduler.tick', () => {
  it('checks every due source in round-robin order', async () => {
    const { scheduler, sources } = setup([due('a1', 'A'), due('a2', 'A'), due('b1', 'B')]);

    await scheduler.tick();

    expect(sources.claimAndCheck.mock.calls.map(([s]: [ApiSpecSource]) => s.id)).toEqual(['a1', 'b1', 'a2']);
  });

  it('never overlaps itself: a tick while the previous one runs is skipped', async () => {
    const { scheduler, sources } = setup([due('a1', 'A')]);
    let release: () => void = () => undefined;
    sources.claimAndCheck.mockImplementationOnce(() => new Promise((resolve) => { release = () => { resolve(null); }; }));

    const first = scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    await scheduler.tick(); // skipped: the first is still inside claimAndCheck
    expect(sources.due).toHaveBeenCalledTimes(1);
    release();
    await first;

    await scheduler.tick(); // the guard is released afterwards
    expect(sources.due).toHaveBeenCalledTimes(2);
  });

  it('stops at the time budget; the rest stays due for the next tick', async () => {
    const { scheduler, sources } = setup([due('a1', 'A'), due('b1', 'B'), due('c1', 'C')]);
    let clock = 0;
    scheduler.clock = () => clock;
    sources.claimAndCheck.mockImplementation(() => {
      clock += SPEC_CHECK_TICK_BUDGET_MS / 2 + 1;
      return Promise.resolve(null);
    });

    await scheduler.tick();

    expect(sources.claimAndCheck).toHaveBeenCalledTimes(2);
  });

  it('review M2: one tenant with slow sources gets at most half the budget; the other tenant is not starved', async () => {
    const slow = Array.from({ length: 6 }, (_, i) => due(`a${String(i)}`, 'A'));
    const fast = Array.from({ length: 6 }, (_, i) => due(`b${String(i)}`, 'B'));
    const { scheduler, sources } = setup([...slow, ...fast]);
    let clock = 0;
    scheduler.clock = () => clock;
    sources.claimAndCheck.mockImplementation((s: ApiSpecSource) => {
      clock += s.tenantId === 'A' ? 10_000 : 1_000;
      return Promise.resolve(null);
    });

    await scheduler.tick();

    const ids = sources.claimAndCheck.mock.calls.map(([s]: [ApiSpecSource]) => s.id);
    // A: starts while its spend < 22.5 s → 3 checks (30 s, one over by at most one check); B: all 6.
    expect(ids.filter((id) => id.startsWith('a'))).toHaveLength(3);
    expect(ids.filter((id) => id.startsWith('b'))).toHaveLength(6);
  });

  it('review M2: a lone tenant may use the whole budget', async () => {
    const { scheduler, sources } = setup(Array.from({ length: 6 }, (_, i) => due(`a${String(i)}`, 'A')));
    let clock = 0;
    scheduler.clock = () => clock;
    sources.claimAndCheck.mockImplementation(() => {
      clock += 10_000;
      return Promise.resolve(null);
    });

    await scheduler.tick();

    expect(sources.claimAndCheck).toHaveBeenCalledTimes(5); // 0,10,20,30,40 s start; 50 s ≥ 45 s stops
  });

  it('tenantShareMs', () => {
    expect([tenantShareMs(0), tenantShareMs(1), tenantShareMs(2), tenantShareMs(10)]).toEqual([45_000, 45_000, 22_500, 22_500]);
  });

  it('one failing check neither stops the sweep nor logs anything but the error name', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const { scheduler, sources } = setup([due('a1', 'A'), due('b1', 'B')]);
    sources.claimAndCheck.mockRejectedValueOnce(new Error('https://specs.example.com/x?token=s3cr3t'));

    await scheduler.tick();

    expect(sources.claimAndCheck).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('s3cr3t');
    warn.mockRestore();
  });

  it('publishes the oldest overdue age (no labels), and 0 when nothing is due', async () => {
    const { scheduler, registry } = setup([due('a1', 'A', 90), due('b1', 'B', 10)]);

    await scheduler.tick();
    expect(await registry.getSingleMetricAsString('og_spec_source_oldest_overdue_seconds')).toContain('og_spec_source_oldest_overdue_seconds 90');

    const idle = setup([]);
    await idle.scheduler.tick();
    expect(await idle.registry.getSingleMetricAsString('og_spec_source_oldest_overdue_seconds')).toContain('og_spec_source_oldest_overdue_seconds 0');
  });
});
