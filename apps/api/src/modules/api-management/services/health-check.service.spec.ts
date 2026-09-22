import 'reflect-metadata';
import { ApiHealthStatus } from '@prisma/client';
import { healthFrom } from './health-check.service';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

describe('healthFrom — the rule that finally populates healthStatus', () => {
  it('is HEALTHY only when every probe passed', () => {
    expect(healthFrom([true])).toBe(ApiHealthStatus.HEALTHY);
    expect(healthFrom([true, true, true])).toBe(ApiHealthStatus.HEALTHY);
  });

  it('is DOWN when every probe failed', () => {
    expect(healthFrom([false])).toBe(ApiHealthStatus.DOWN);
    expect(healthFrom([false, false])).toBe(ApiHealthStatus.DOWN);
  });

  it('is DEGRADED on a mix — the case a boolean would hide', () => {
    expect(healthFrom([true, false])).toBe(ApiHealthStatus.DEGRADED);
    expect(healthFrom([false, true, true])).toBe(ApiHealthStatus.DEGRADED);
  });

  it('is UNKNOWN with no probes, rather than claiming health nothing measured', () => {
    expect(healthFrom([])).toBe(ApiHealthStatus.UNKNOWN);
  });
});
