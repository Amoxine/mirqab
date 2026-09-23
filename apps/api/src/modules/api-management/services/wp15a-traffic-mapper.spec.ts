import 'reflect-metadata';
import type { ApiDefinition } from '@prisma/client';
import { mapToTykFormat, mapToTykOas } from './tyk-mappers';
import { EDGE_BODY_LIMIT_BYTES } from '../dto/api-config.dto';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

const TENANT = { tykOrgId: 'og-t1', slug: 'acme' };

function apiDef(config: Record<string, unknown>, defFormat: 'CLASSIC' | 'OAS' = 'OAS'): ApiDefinition {
  return {
    id: 'a1', tenantId: 't1', name: 'Orders', slug: 'orders', tykApiId: null,
    proxyUrl: 'http://orders:4000', listenPath: '/orders/', authType: 'NONE', status: 'ACTIVE',
    config, syncStatus: 'PENDING', syncError: null, syncState: null, defFormat,
    oasDocument: null, lastSyncedAt: null, healthStatus: 'UNKNOWN',
    createdAt: new Date(0), updatedAt: new Date(0),
  } as unknown as ApiDefinition;
}

const oas = (c: Record<string, unknown>) =>
  mapToTykOas(apiDef(c), TENANT) as unknown as {
    paths: Record<string, Record<string, { operationId?: string }>>;
    'x-tyk-api-gateway': {
      upstream: Record<string, unknown>;
      middleware?: { global?: Record<string, unknown>; operations?: Record<string, { circuitBreaker: Record<string, unknown> }> };
    };
  };
const classic = (c: Record<string, unknown>) =>
  mapToTykFormat(apiDef(c, 'CLASSIC'), TENANT) as unknown as {
    proxy: Record<string, unknown>;
    version_data: { versions: { Default: { extended_paths?: Record<string, { path: string; method: string }[]> } } };
    uptime_tests?: { check_list: Record<string, unknown>[] };
  };

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

describe('WP15a traffic middleware — both mappers', () => {
  it('enforced timeout: OAS duration string, classic seconds, every method covered', () => {
    expect(oas({ timeoutSeconds: 1 })['x-tyk-api-gateway'].upstream.enforceTimeout).toEqual({
      enabled: true,
      duration: '1s',
    });
    const ext = classic({ timeoutSeconds: 1 }).version_data.versions.Default.extended_paths;
    expect(ext?.hard_timeouts.map((e) => e.method)).toEqual(ALL_METHODS);
    // GET-only would leave every write request unprotected — the reason this is expanded per method.
    expect(ext?.hard_timeouts.every((e) => e.path === '/.*')).toBe(true);
  });

  it('request size limit lands on middleware.global in OAS, extended_paths in classic', () => {
    expect(oas({ requestSizeLimitBytes: 2048 })['x-tyk-api-gateway'].middleware?.global?.requestSizeLimit).toEqual({
      enabled: true,
      value: 2048,
    });
    expect(classic({ requestSizeLimitBytes: 2048 }).version_data.versions.Default.extended_paths?.size_limits).toHaveLength(
      ALL_METHODS.length,
    );
  });

  it('the per-API size limit can never exceed the edge limit, so the gateway is the smaller enforcer', () => {
    // The DTO rejects anything larger at write time; this pins the constant the cap is built on.
    expect(EDGE_BODY_LIMIT_BYTES).toBe(10_485_760);
  });

  it('load balancing: OAS takes {url,weight}, classic repeats a target to express weight', () => {
    const lb = { loadBalancing: { targets: [{ url: 'http://a:1', weight: 1 }, { url: 'http://b:1', weight: 2 }] } };
    expect(oas(lb)['x-tyk-api-gateway'].upstream.loadBalancing).toEqual({
      enabled: true,
      targets: [{ url: 'http://a:1', weight: 1 }, { url: 'http://b:1', weight: 2 }],
    });
    // Classic has no weight field at all; repetition IS the weight.
    expect(classic(lb).proxy.target_list).toEqual(['http://a:1', 'http://b:1', 'http://b:1']);
    expect(classic(lb).proxy.enable_load_balancing).toBe(true);
  });

  it('uptime tests reach both formats', () => {
    const ut = { uptimeTests: [{ url: 'http://orders:4000/health', timeoutSeconds: 2 }] };
    expect(oas(ut)['x-tyk-api-gateway'].upstream.uptimeTests).toEqual({
      enabled: true,
      tests: [{ url: 'http://orders:4000/health', method: 'GET', timeout: '2s' }],
    });
    expect(classic(ut).uptime_tests?.check_list).toHaveLength(1);
  });

  describe('circuit breaker — OAS has no API-level field, so it is synthesised', () => {
    const cb = { circuitBreaker: { threshold: 0.5, sampleSize: 4, coolDownSeconds: 10 } };

    it('synthesises a catch-all path with one operation per method', () => {
      const d = oas(cb);
      // Measured: `circuitBreaker` exists only on X-Tyk-Operation, so an API-wide breaker needs a
      // path to hang off. Verified live on v5.15.0 — the breaker trips and the gateway logs
      // "[CIRCUIT BREAKER] Breaker tripped for path: /{wildcard}".
      expect(Object.keys(d.paths)).toEqual(['/{wildcard}']);
      const ops = d['x-tyk-api-gateway'].middleware?.operations ?? {};
      expect(Object.keys(ops).sort()).toEqual(ALL_METHODS.map((m) => `catchAll${m}`).sort());
      expect(ops.catchAllGET.circuitBreaker).toEqual({
        enabled: true,
        threshold: 0.5,
        sampleSize: 4,
        coolDownPeriod: 10,
        halfOpenStateEnabled: true,
      });
    });

    it('keeps paths empty when no breaker is configured — no gratuitous catch-all', () => {
      expect(oas({})).toHaveProperty('paths', {});
    });

    it('classic expresses the same breaker as extended_paths on every method', () => {
      const cbs = classic(cb).version_data.versions.Default.extended_paths?.circuit_breakers;
      expect(cbs?.map((e) => e.method)).toEqual(ALL_METHODS);
      expect(cbs?.every((e) => e.path === '/.*')).toBe(true);
    });
  });

  it('emits nothing when no traffic middleware is configured', () => {
    expect(classic({}).version_data.versions.Default.extended_paths).toBeUndefined();
    expect(oas({})['x-tyk-api-gateway'].upstream).not.toHaveProperty('enforceTimeout');
  });
});
