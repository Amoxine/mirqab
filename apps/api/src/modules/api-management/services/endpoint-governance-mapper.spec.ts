import 'reflect-metadata';
import type { ApiDefinition, Prisma } from '@prisma/client';
import { mapToTykOas } from './tyk-mappers';
import {
  CATCH_ALL_DEPTH,
  CATCH_ALL_METHODS,
  buildCatchAllOperations,
  buildGovernedOperations,
  EndpointRenderError,
  hasRealOperations,
  isSubset,
  readBackMismatches,
  type EndpointRef,
} from './endpoint-operations';
import { CONTROL_TYK_FIELD, OFFERABLE_ENDPOINT_FIELDS } from './endpoint-capabilities';
import type { EndpointGovernance } from './endpoint-governance';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

const TENANT = { tykOrgId: 'og-t1', slug: 'acme' };

function apiDef(config: Record<string, unknown> | null): ApiDefinition {
  return {
    id: 'a1',
    tenantId: 't1',
    name: 'Orders',
    slug: 'orders',
    tykApiId: null,
    proxyUrl: 'http://orders:4000',
    listenPath: '/orders/',
    authType: 'AUTH_TOKEN',
    status: 'ACTIVE',
    config: config as Prisma.JsonValue,
    syncStatus: 'PENDING',
    syncError: null,
    syncState: null,
    defFormat: 'OAS',
    parentApiId: null,
    retiredAt: null,
    versionName: null,
    oasDocument: null,
    lastSyncedAt: null,
    healthStatus: 'UNKNOWN',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as ApiDefinition;
}

const refs: EndpointRef[] = [
  { key: 'listOrders', method: 'GET', path: '/orders' },
  { key: 'createOrder', method: 'POST', path: '/orders' },
  { key: 'getOrder', method: 'GET', path: '/orders/{id}' },
  { key: 'root', method: 'GET', path: '/' },
  { key: 'item', method: 'GET', path: '/{sku}' },
  { key: 'headOrders', method: 'HEAD', path: '/orders' },
];

interface Op {
  operationId: string;
  requestBody?: { content: Record<string, { schema: unknown }> };
}
interface Doc {
  paths: Record<string, Record<string, unknown>>;
  'x-tyk-api-gateway': { middleware?: { global?: Record<string, unknown>; operations?: Record<string, Record<string, unknown>> } };
}
const doc = (config: Record<string, unknown> | null, endpointRefs: EndpointRef[] = refs): Doc =>
  mapToTykOas(apiDef(config), TENANT, '', [], endpointRefs) as unknown as Doc;
const ops = (d: Doc) => d['x-tyk-api-gateway'].middleware?.operations ?? {};
const opAt = (d: Doc, path: string, method: string) =>
  (d.paths[path] as Record<string, unknown> | undefined)?.[method] as Op | undefined;
const mwAt = (d: Doc, path: string, method: string) => {
  const op = opAt(d, path, method);
  return op ? ops(d)[op.operationId] : undefined;
};

const ALL_CONTROLS: Record<string, EndpointGovernance> = {
  listOrders: { enabled: false, cache: { timeoutSeconds: 5 } },
  createOrder: {
    auth: 'public',
    rateLimit: { rate: 2, per: 10 },
    timeoutSeconds: 1,
    requestSizeLimitBytes: 10,
    mock: { code: 201, body: '{}', headers: [{ name: 'X-M', value: '1' }] },
    validateRequestSchema: { type: 'object', required: ['sku'] },
  },
};

describe('mapToTykOas with endpoint governance (OAS-03)', () => {
  it('is IDENTICAL to the pre-governance output without governance, whatever refs are passed (rule 10)', () => {
    for (const config of [null, {}, { mock: { code: 200, body: 'x' } }, { endpoints: {} }, { endpoints: { gone: { enabled: false } } }]) {
      expect(mapToTykOas(apiDef(config), TENANT, '', [], refs)).toEqual(mapToTykOas(apiDef(config), TENANT));
    }
  });

  it('renders every control onto the Tyk field the contract names', () => {
    const d = doc({ endpoints: ALL_CONTROLS });
    expect(mwAt(d, '/orders', 'get')).toEqual({
      block: { enabled: true },
      cache: { enabled: true, timeout: 5, cacheResponseCodes: [200] },
    });
    expect(mwAt(d, '/orders', 'post')).toEqual({
      ignoreAuthentication: { enabled: true },
      rateLimit: { enabled: true, rate: 2, per: '10s' },
      enforceTimeout: { enabled: true, value: 1 },
      requestSizeLimit: { enabled: true, value: 10 },
      mockResponse: { enabled: true, code: 201, body: '{}', headers: [{ name: 'X-M', value: '1' }] },
      validateRequest: { enabled: true, errorResponseCode: 422 },
    });
    expect(opAt(d, '/orders', 'post')?.requestBody?.content['application/json'].schema).toEqual({ type: 'object', required: ['sku'] });
    expect(d['x-tyk-api-gateway'].middleware?.global).toMatchObject({
      ignoreCase: { enabled: true },
      cache: { enabled: true, timeout: 60, cacheAllSafeRequests: false },
    });
  });

  it('emits ONLY offerable Tyk fields (flipping a capability to unverified fails here)', () => {
    const everything = { endpoints: ALL_CONTROLS, restrictToSpec: true };
    const offered = new Set<string>(Object.values(CONTROL_TYK_FIELD));
    for (const middleware of Object.values(ops(doc(everything)))) {
      for (const field of Object.keys(middleware)) {
        expect(OFFERABLE_ENDPOINT_FIELDS).toContain(field);
        expect(offered.has(field)).toBe(true);
      }
    }
  });

  it('names operations og_ep<position> and twins og_ep<position>_s, never the spec operationId', () => {
    const d = doc({ endpoints: { getOrder: { enabled: false } } });
    expect(opAt(d, '/orders/{id}', 'get')?.operationId).toBe('og_ep2');
    expect(opAt(d, '/orders/{id}/', 'get')?.operationId).toBe('og_ep2_s');
    expect(ops(d).og_ep2_s).toEqual({ block: { enabled: true } });
    expect(Object.keys(ops(d))).not.toContain('getOrder');
  });

  it('closes the trailing-slash and case bypasses (G2, G3) and declares path parameters', () => {
    const d = doc({ endpoints: { getOrder: { enabled: false } } });
    expect(d.paths['/orders/{id}'].parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]);
    expect(d.paths['/orders/{id}/'].parameters).toEqual(d.paths['/orders/{id}'].parameters);
    expect(d['x-tyk-api-gateway'].middleware?.global?.ignoreCase).toEqual({ enabled: true });
  });

  it('gives "/" no twin and a path spelled with a trailing slash its bare form', () => {
    const d = doc({ endpoints: { root: { enabled: false }, x: { enabled: false } } }, [...refs, { key: 'x', method: 'GET', path: '/x/' }]);
    expect(Object.keys(d.paths)).not.toContain('//');
    expect(opAt(d, '/x', 'get')?.operationId).toBe('og_ep6_s');
  });

  it('never emits an orphan or an unselected endpoint in open mode', () => {
    const d = doc({ endpoints: { getOrder: { enabled: false }, gone: { enabled: false } } });
    expect(Object.keys(d.paths).sort()).toEqual(['/orders/{id}', '/orders/{id}/']);
  });

  it('allow-list mode: every indexed endpoint gets allow except blocked ones, and no catch-all is emitted', () => {
    const d = doc({ restrictToSpec: true, endpoints: { getOrder: { enabled: false } }, mock: { code: 200, body: 'x' } });
    expect(mwAt(d, '/orders', 'get')).toMatchObject({ allow: { enabled: true } });
    expect(mwAt(d, '/orders', 'head')).toMatchObject({ allow: { enabled: true } });
    expect(mwAt(d, '/orders/{id}', 'get')).toMatchObject({ block: { enabled: true } });
    expect(mwAt(d, '/orders/{id}', 'get')).not.toHaveProperty('allow');
    expect(Object.keys(ops(d)).some((id) => id.startsWith('catchAll'))).toBe(false);
  });

  it('copies API-wide per-operation middleware onto every real operation, the endpoint winning (G5)', () => {
    const d = doc({ mock: { code: 200, body: 'wide' }, endpoints: { getOrder: { timeoutSeconds: 3 }, createOrder: { mock: { code: 202, body: 'mine' } } } });
    expect(mwAt(d, '/orders/{id}', 'get')).toEqual({
      mockResponse: { enabled: true, code: 200, body: 'wide' },
      enforceTimeout: { enabled: true, value: 3 },
    });
    expect(mwAt(d, '/orders', 'post')).toEqual({ mockResponse: { enabled: true, code: 202, body: 'mine' } });
  });

  it('keeps the catch-all family for undeclared paths, merged into a real path item of the same shape (rule 5)', () => {
    const d = doc({ mock: { code: 200, body: 'wide' }, endpoints: { item: { enabled: false }, root: { auth: 'public' } } });
    // `/{sku}` (real) and `/{wildcard}` (family) route the same: one path item, the real GET, the family's other methods.
    expect(d.paths).not.toHaveProperty(['/{wildcard}']);
    expect(opAt(d, '/{sku}', 'get')?.operationId).toBe('og_ep4');
    expect(opAt(d, '/{sku}', 'post')?.operationId).toBe('catchAllPOST');
    expect(opAt(d, '/{sku}/', 'post')?.operationId).toBe('catchAllPOSTSlash');
    expect(opAt(d, '/', 'get')?.operationId).toBe('og_ep3');
    expect(opAt(d, '/', 'post')?.operationId).toBe('catchAllRootPOST');
    // Deeper members of the family are untouched.
    expect(d.paths).toHaveProperty(['/{wildcard}/{wildcard2}']);
    // Every operation in a path item has middleware, and every middleware entry has an operation.
    const emitted = Object.values(d.paths).flatMap((item) => Object.entries(item).filter(([k]) => k !== 'parameters').map(([, op]) => (op as Op).operationId));
    expect(emitted.sort()).toEqual(Object.keys(ops(d)).sort());
  });

  it('puts real paths before catch-all paths (rule 7)', () => {
    const keys = Object.keys(doc({ mock: { code: 200, body: 'x' }, endpoints: { getOrder: { enabled: false } } }).paths);
    expect(keys.slice(0, 2)).toEqual(['/orders/{id}', '/orders/{id}/']);
  });

  it('never emits two path keys with the same routing shape', () => {
    const d = doc({ restrictToSpec: true }, [...refs, { key: 'other', method: 'DELETE', path: '/orders/{orderId}' }]);
    const shapes = Object.keys(d.paths).map((p) => p.replace(/\{[^}]*\}/g, '{}'));
    expect(new Set(shapes).size).toBe(shapes.length);
    expect(opAt(d, '/orders/{id}', 'delete')?.operationId).toBe('og_ep6');
  });

  it('ignores a per-endpoint cache while the API has an API-wide cache', () => {
    const d = doc({ cache: { timeoutSeconds: 30 }, endpoints: { listOrders: { cache: { timeoutSeconds: 5 } } } });
    expect(mwAt(d, '/orders', 'get')).toEqual({});
    expect(d['x-tyk-api-gateway'].middleware?.global?.cache).toMatchObject({ timeout: 30, cacheAllSafeRequests: true });
  });

  it('publishes the API-wide schema on real operations that carry the API-wide validateRequest', () => {
    const schema = { type: 'object' };
    const d = doc({ validateRequestSchema: schema, endpoints: { getOrder: { enabled: false } } });
    expect(opAt(d, '/orders/{id}', 'get')?.requestBody?.content['application/json'].schema).toEqual(schema);
  });
});

describe('buildGovernedOperations', () => {
  it('without selection is exactly the catch-all family', () => {
    const perOperation = { mockResponse: { enabled: true } };
    expect(buildGovernedOperations({ refs, endpoints: {}, restrictToSpec: false, perOperation, apiWideCache: false })).toEqual({
      ...buildCatchAllOperations(perOperation),
      global: {},
    });
  });

  it('keeps the family size for undeclared depths', () => {
    const { operations } = buildGovernedOperations({
      refs,
      endpoints: { getOrder: { enabled: false } },
      restrictToSpec: false,
      perOperation: { mockResponse: { enabled: true } },
      apiWideCache: false,
    });
    const family = Object.keys(operations).filter((id) => id.startsWith('catchAll'));
    expect(family).toHaveLength((1 + 2 * CATCH_ALL_DEPTH) * CATCH_ALL_METHODS.length);
  });

  const build = (r: EndpointRef[], restrictToSpec = false) =>
    buildGovernedOperations({
      refs: r,
      endpoints: Object.fromEntries(r.map((x) => [x.key, { enabled: false }])),
      restrictToSpec,
      perOperation: {},
      apiWideCache: false,
    });

  it('M5: refuses two selected endpoints that route the same (case, parameter names), naming both', () => {
    expect(() => build([{ key: 'up', method: 'GET', path: '/Admin' }, { key: 'low', method: 'GET', path: '/admin' }])).toThrow(/"up".*"low"/);
    expect(() => build([{ key: 'x', method: 'GET', path: '/a/{x}' }, { key: 'y', method: 'GET', path: '/a/{y}' }])).toThrow(EndpointRenderError);
  });

  it('M5: the same routing shape with different methods is one path item, not an error', () => {
    const out = build([{ key: 'g', method: 'GET', path: '/Admin' }, { key: 'p', method: 'POST', path: '/admin' }]);
    const shapes = Object.keys(out.paths).map((path) => path.toLowerCase());
    expect(new Set(shapes).size).toBe(shapes.length);
    expect(Object.keys(out.operations).sort()).toEqual(['og_ep0', 'og_ep0_s', 'og_ep1', 'og_ep1_s']);
  });

  it('L6: allow-list mode with nothing emittable fails closed (throws) instead of emitting an open API', () => {
    expect(() => build([{ key: 'q', method: 'QUERY', path: '/q' }], true)).toThrow(EndpointRenderError);
  });

  it('skips a method outside the eight and a hostile "__proto__" key stays data', () => {
    const odd: EndpointRef[] = [{ key: '__proto__', method: 'GET', path: '/p' }, { key: 'q', method: 'QUERY', path: '/q' }];
    const endpoints = JSON.parse('{"__proto__":{"enabled":false},"q":{"enabled":false}}') as Record<string, EndpointGovernance>;
    const out = buildGovernedOperations({ refs: odd, endpoints, restrictToSpec: false, perOperation: {}, apiWideCache: false });
    expect(Object.keys(out.paths)).toEqual(['/p', '/p/']);
    expect(out.operations.og_ep0).toEqual({ block: { enabled: true } });
  });
});

describe('readBackMismatches (subset semantics)', () => {
  const sentOps = {
    og_ep0: { block: { enabled: true } },
    og_ep1: { rateLimit: { enabled: true, rate: 2, per: '10s' }, mockResponse: { enabled: true, code: 201, body: '', headers: [{ name: 'a', value: 'b' }] } },
    catchAllGET: { mockResponse: { enabled: true } },
  };
  const effective = (operations: unknown) => ({ 'x-tyk-api-gateway': { middleware: { operations } } });
  const sent = effective(sentOps);

  it('accepts a node that reports every sent field, ignoring injected defaults and catch-alls', () => {
    expect(
      readBackMismatches(sent, effective({
        og_ep0: { block: { enabled: true, extra: 1 } },
        // MEASURED on 5.15.0: an empty `body` is omitted on read-back.
        og_ep1: { rateLimit: { enabled: true, rate: 2, per: '10s', smoothing: {} }, mockResponse: { enabled: true, code: 201, headers: [{ name: 'a', value: 'b' }], fromOASExamples: {} } },
      })),
    ).toEqual([]);
  });

  it('names an operation that is missing, changed, or has a changed list', () => {
    expect(readBackMismatches(sent, effective({ og_ep1: sentOps.og_ep1 }))).toEqual(['og_ep0']);
    expect(readBackMismatches(sent, effective({ og_ep0: { block: { enabled: false } }, og_ep1: sentOps.og_ep1 }))).toEqual(['og_ep0']);
    expect(
      readBackMismatches(sent, effective({ og_ep0: sentOps.og_ep0, og_ep1: { ...sentOps.og_ep1, mockResponse: { ...sentOps.og_ep1.mockResponse, headers: [] } } })),
    ).toEqual(['og_ep1']);
  });

  // H1, MEASURED on 5.15.0: Tyk canonicalises `rateLimit.per` on storage.
  it.each([
    ['60s', '1m'],
    ['90s', '1m30s'],
    ['3600s', '1h'],
    ['86400s', '24h'],
    ['30s', '30s'],
    ['10s', '10s'],
  ])('accepts rateLimit.per sent %s and read back %s (same duration)', (sentPer, backPer) => {
    const one = (per: string) => effective({ og_ep0: { rateLimit: { enabled: true, rate: 2, per } } });
    expect(readBackMismatches(one(sentPer), one(backPer))).toEqual([]);
  });

  it('still flags a different duration, and does not treat other strings as durations', () => {
    const rl = (per: string) => effective({ og_ep0: { rateLimit: { enabled: true, rate: 2, per } } });
    expect(readBackMismatches(rl('60s'), rl('2m'))).toEqual(['og_ep0']);
    expect(readBackMismatches(rl('60s'), rl('60'))).toEqual(['og_ep0']);
    const mock = (body: string) => effective({ og_ep0: { mockResponse: { enabled: true, code: 200, body } } });
    expect(readBackMismatches(mock('60s'), mock('1m'))).toEqual(['og_ep0']);
  });

  it('M4: an absent effective key equals a sent "", [] or false — and nothing else', () => {
    expect(isSubset({ body: '' }, {})).toBe(true);
    expect(isSubset({ headers: [] }, {})).toBe(true);
    expect(isSubset({ cacheAllSafeRequests: false }, {})).toBe(true);
    expect(isSubset({ code: 0 }, {})).toBe(false);
    expect(isSubset({ enabled: true }, {})).toBe(false);
    expect(isSubset({ timeout: null }, {})).toBe(false);
    expect(isSubset({ body: 'x' }, {})).toBe(false);
    const sentMock = effective({ og_ep0: { mockResponse: { enabled: true, code: 200, body: '' } } });
    expect(readBackMismatches(sentMock, effective({ og_ep0: { mockResponse: { enabled: true, code: 200 } } }))).toEqual([]);
  });

  it('MEASURED live (5.15.0): global.cache reads back without cacheAllSafeRequests:false — still in sync', () => {
    const doc = (cache: unknown) => ({
      'x-tyk-api-gateway': { middleware: { global: { ignoreCase: { enabled: true }, cache }, operations: { og_ep0: { cache: { enabled: true, timeout: 60, cacheResponseCodes: [200] } } } } },
    });
    const sentDoc = doc({ enabled: true, timeout: 60, cacheAllSafeRequests: false });
    expect(readBackMismatches(sentDoc, doc({ enabled: true, timeout: 60 }))).toEqual([]);
    // A node that CACHES everything does not match.
    expect(readBackMismatches(sentDoc, doc({ enabled: true, timeout: 60, cacheAllSafeRequests: true }))).toEqual(['middleware.global.cache']);
  });

  it('L10: compares the og_ep operationIds in paths and the global keys that were sent', () => {
    const full = (opId: string, ignoreCase: unknown) => ({
      paths: { '/orders': { get: { operationId: opId } } },
      'x-tyk-api-gateway': { middleware: { global: { ignoreCase, cache: { enabled: true, timeout: 60 } }, operations: { og_ep0: { block: { enabled: true } } } } },
    });
    const sentDoc = full('og_ep0', { enabled: true });
    expect(readBackMismatches(sentDoc, full('og_ep0', { enabled: true }))).toEqual([]);
    expect(readBackMismatches(sentDoc, full('og_ep9', { enabled: true }))).toEqual(['paths./orders.get']);
    expect(readBackMismatches(sentDoc, full('og_ep0', { enabled: false }))).toEqual(['middleware.global.ignoreCase']);
    const noCache = full('og_ep0', { enabled: true });
    delete (noCache['x-tyk-api-gateway'].middleware.global as Record<string, unknown>).cache;
    expect(readBackMismatches(sentDoc, noCache)).toEqual(['middleware.global.cache']);
  });

  it('treats an unreadable document as missing everything', () => {
    expect(readBackMismatches(sent, 'garbage')).toEqual(['og_ep0', 'og_ep1']);
    expect(isSubset({ a: 1 }, null)).toBe(false);
    expect(isSubset([1], [1, 2])).toBe(false);
  });

  it('owes a read-back only when real operations were sent', () => {
    expect(hasRealOperations(sent)).toBe(true);
    expect(hasRealOperations(effective({ catchAllGET: {} }))).toBe(false);
  });
});
