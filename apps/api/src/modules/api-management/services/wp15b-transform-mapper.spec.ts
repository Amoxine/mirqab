import 'reflect-metadata';
import type { ApiDefinition } from '@prisma/client';
import { mapToTykFormat, mapToTykOas } from './tyk-mappers';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

const TENANT = { tykOrgId: 'og-t1', slug: 'acme' };
const apiDef = (config: Record<string, unknown>): ApiDefinition =>
  ({
    id: 'a1', tenantId: 't1', name: 'Orders', slug: 'orders', tykApiId: null,
    proxyUrl: 'http://orders:4000', listenPath: '/orders/', authType: 'NONE', status: 'ACTIVE',
    config, syncStatus: 'PENDING', syncError: null, syncState: null, defFormat: 'OAS',
    oasDocument: null, lastSyncedAt: null, healthStatus: 'UNKNOWN',
    createdAt: new Date(0), updatedAt: new Date(0),
  }) as unknown as ApiDefinition;

interface OasShape {
  paths: Record<string, Record<string, unknown>>;
  'x-tyk-api-gateway': {
    server: Record<string, unknown>;
    middleware?: { global?: Record<string, unknown>; operations?: Record<string, Record<string, unknown>> };
  };
}
const oas = (c: Record<string, unknown>) => mapToTykOas(apiDef(c), TENANT) as unknown as OasShape;
const classic = (c: Record<string, unknown>) =>
  mapToTykFormat(apiDef(c), TENANT) as unknown as {
    version_data: { versions: { Default: { extended_paths?: Record<string, unknown> } } };
    cache_options?: Record<string, unknown>;
    enable_detailed_recording?: boolean;
  };
const ext = (c: Record<string, unknown>) => classic(c).version_data.versions.Default.extended_paths ?? {};

describe('WP15b transform middleware', () => {
  it('request/response header transforms land on middleware.global in OAS', () => {
    const cfg = {
      transformRequestHeaders: { add: [{ name: 'X-A', value: '1' }], remove: ['X-B'] },
      transformResponseHeaders: { add: [{ name: 'X-C', value: '2' }] },
    };
    const g = oas(cfg)['x-tyk-api-gateway'].middleware?.global ?? {};
    expect(g.transformRequestHeaders).toEqual({ enabled: true, add: [{ name: 'X-A', value: '1' }], remove: ['X-B'] });
    expect(g.transformResponseHeaders).toEqual({ enabled: true, add: [{ name: 'X-C', value: '2' }] });
  });

  it('classic expresses the same transforms as extended_paths, one entry per method', () => {
    const e = ext({ transformRequestHeaders: { add: [{ name: 'X-A', value: '1' }], remove: ['X-B'] } });
    const entries = e.transform_headers as { method: string; add_headers: Record<string, string> }[];
    expect(entries).toHaveLength(5);
    // classic takes a map, OAS takes a list of {name,value} — not a straight rename.
    expect(entries[0].add_headers).toEqual({ 'X-A': '1' });
  });

  it('url rewrite and mock are per-operation, so they ride the catch-all path', () => {
    const d = oas({ urlRewrite: { pattern: '/old/(.*)', rewriteTo: '/new/$1' }, mock: { code: 418, body: 'x' } });
    expect(d.paths).toHaveProperty(['/{wildcard}']);
    const op = d['x-tyk-api-gateway'].middleware?.operations?.catchAllGET ?? {};
    expect(op.urlRewrite).toEqual({ enabled: true, pattern: '/old/(.*)', rewriteTo: '/new/$1' });
    expect(op.mockResponse).toEqual({ enabled: true, code: 418, body: 'x' });
  });

  it('classic puts the mock under extended_paths.white_list — one level up it is silently ignored', () => {
    // Measured: a white_list placed beside extended_paths rather than inside it does nothing and the
    // request reaches the upstream, which looks like a broken mock rather than a misplaced key.
    const wl = ext({ mock: { code: 418, body: '{"m":1}' } }).white_list as { method_actions: Record<string, unknown> }[];
    expect(wl).toHaveLength(5);
    expect(wl[0].method_actions).toHaveProperty('GET');
  });

  it('cache maps to middleware.global.cache in OAS and cache_options in classic', () => {
    const cfg = { cache: { timeoutSeconds: 60 } };
    expect(oas(cfg)['x-tyk-api-gateway'].middleware?.global?.cache).toEqual({
      enabled: true,
      timeout: 60,
      cacheAllSafeRequests: true,
    });
    expect(classic(cfg).cache_options).toMatchObject({ enable_cache: true, cache_timeout: 60 });
    expect(ext(cfg).cache).toEqual(['/.*']);
  });

  it('detailed recording is per-API and off unless asked (O9)', () => {
    // It hangs off `server`, NOT off trafficLogs: trafficLogs is whether to record, this is how much.
    expect(oas({ detailedRecording: true })['x-tyk-api-gateway'].server.detailedActivityLogs).toEqual({ enabled: true });
    expect(classic({ detailedRecording: true }).enable_detailed_recording).toBe(true);
    // Absent by default — the gateway-wide default stays false.
    expect(oas({})['x-tyk-api-gateway'].server).not.toHaveProperty('detailedActivityLogs');
    expect(classic({})).not.toHaveProperty('enable_detailed_recording');
  });

  it('emits nothing when no transform is configured', () => {
    expect(oas({})).toHaveProperty('paths', {});
    expect(ext({})).toEqual({});
  });
});
