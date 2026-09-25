import { buildEndpointIndex, type EndpointRow } from './oas-endpoints';
import { diffEndpoints, governanceImpact } from './spec-diff';

const ok = { 200: { description: 'ok' } };
const indexOf = (paths: Record<string, unknown>): EndpointRow[] => buildEndpointIndex({ paths }).endpoints;

const BASE = {
  '/orders': {
    get: { operationId: 'listOrders', summary: 'List', tags: ['orders'], responses: ok },
    post: { operationId: 'createOrder', responses: ok },
  },
  '/orders/{id}': {
    get: {
      operationId: 'getOrder',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: ok,
    },
  },
};

interface Case {
  label: string;
  after: Record<string, unknown>;
  added: string[];
  removed: string[];
  changed: Record<string, string[]>;
}

const CASES: Case[] = [
  { label: 'identical documents', after: BASE, added: [], removed: [], changed: {} },
  {
    label: 'a renamed operationId is removed + added, never changed',
    after: { ...BASE, '/orders': { ...BASE['/orders'], get: { ...BASE['/orders'].get, operationId: 'listAllOrders' } } },
    added: ['listAllOrders'],
    removed: ['listOrders'],
    changed: {},
  },
  {
    label: 'a changed path parameter schema shows only through the fingerprint',
    after: {
      ...BASE,
      '/orders/{id}': {
        get: { ...BASE['/orders/{id}'].get, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }] },
      },
    },
    added: [],
    removed: [],
    changed: { getOrder: ['fingerprint'] },
  },
  {
    label: 'a moved operation (same operationId, new path) is a change of path',
    after: { '/orders': BASE['/orders'], '/v2/orders/{id}': BASE['/orders/{id}'] },
    added: [],
    removed: [],
    changed: { getOrder: ['path'] },
  },
  {
    label: 'summary, tags, deprecated and security are each named',
    after: {
      ...BASE,
      '/orders': {
        ...BASE['/orders'],
        get: { ...BASE['/orders'].get, summary: 'List all', tags: ['orders', 'public'], deprecated: true, security: [{ key: [] }] },
      },
    },
    added: [],
    removed: [],
    changed: { listOrders: ['summary', 'tags', 'deprecated', 'securitySchemes', 'fingerprint'] },
  },
  {
    label: 'a new duplicate operationId turns both keys into "METHOD path" (removed + added)',
    after: { ...BASE, '/orders': { ...BASE['/orders'], post: { operationId: 'listOrders', responses: ok } } },
    added: ['GET /orders', 'POST /orders'],
    removed: ['listOrders', 'createOrder'],
    changed: {},
  },
  {
    label: 'hostile keys are ordinary keys',
    after: {
      ...BASE,
      '/p': { get: { operationId: '__proto__' }, post: { operationId: 'constructor' }, put: { operationId: 'hasOwnProperty' } },
    },
    added: ['__proto__', 'hasOwnProperty', 'constructor'], // index order: get, put, post
    removed: [],
    changed: {},
  },
];

describe('diffEndpoints', () => {
  const before = indexOf(BASE);

  it.each(CASES)('$label', ({ after, added, removed, changed }) => {
    const diff = diffEndpoints(before, indexOf(after));

    expect(diff.added.map((row) => row.key)).toEqual(added);
    expect(diff.removed.map((row) => row.key)).toEqual(removed);
    expect(Object.fromEntries(diff.changed.map((change) => [change.key, change.fields]))).toEqual(changed);
  });

  it('carries the rows on both sides of a change', () => {
    const after = indexOf({ ...BASE, '/orders': { ...BASE['/orders'], get: { ...BASE['/orders'].get, summary: 'New' } } });
    const [change] = diffEndpoints(before, after).changed;

    expect(change.before.summary).toBe('List');
    expect(change.after.summary).toBe('New');
  });

  it('compares index fields only when the stored row predates the fingerprint', () => {
    // A row stored by OAS-01 has no `fingerprint` property at all.
    const legacy = before.map(({ fingerprint: _dropped, ...row }) => row) as unknown as EndpointRow[];
    const schemaOnly = indexOf({
      ...BASE,
      '/orders/{id}': { get: { ...BASE['/orders/{id}'].get, responses: { 404: { description: 'no' } } } },
    });

    expect(diffEndpoints(legacy, schemaOnly).changed).toEqual([]);
    expect(diffEndpoints(legacy.map((row) => ({ ...row, fingerprint: null })), schemaOnly).changed).toEqual([]);
    expect(diffEndpoints(before, schemaOnly).changed.map((c) => c.key)).toEqual(['getOrder']);
  });

  it('handles two 5000-endpoint documents quickly', () => {
    const big = (suffix: string): Record<string, unknown> => {
      const paths: Record<string, unknown> = {};
      for (let i = 0; i < 5000; i += 1) paths[`/p${String(i)}`] = { get: { operationId: `op${String(i)}`, summary: i % 2 ? suffix : 's' } };
      return paths;
    };
    const left = indexOf(big('a'));
    const right = indexOf(big('b'));

    const started = Date.now();
    const diff = diffEndpoints(left, right);

    expect(Date.now() - started).toBeLessThan(2000);
    expect(diff.changed).toHaveLength(2500);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });
});

describe('governanceImpact', () => {
  const before = indexOf(BASE);
  const after = indexOf({ '/orders': { get: { ...BASE['/orders'].get, summary: 'Changed' } } });
  const diff = diffEndpoints(before, after);

  it('lists removed governed endpoints with their governance, and changed governed keys', () => {
    const governance = { createOrder: { enabled: false }, listOrders: { auth: 'public' }, orphan: { enabled: false } };

    expect(governanceImpact(diff, governance)).toEqual({
      removedGoverned: [{ key: 'createOrder', governance: { enabled: false } }],
      changedGoverned: ['listOrders'],
    });
  });

  it('is empty when nothing governed is touched', () => {
    expect(governanceImpact(diff, {})).toEqual({ removedGoverned: [], changedGoverned: [] });
    expect(governanceImpact(diffEndpoints(before, before), { listOrders: { enabled: false } })).toEqual({
      removedGoverned: [],
      changedGoverned: [],
    });
  });

  it('never treats an inherited property as governance', () => {
    const hostile = indexOf({ '/p': { get: { operationId: 'constructor' }, post: { operationId: 'toString' } } });

    expect(governanceImpact(diffEndpoints(hostile, []), {})).toEqual({ removedGoverned: [], changedGoverned: [] });
    const own = JSON.parse('{"__proto__":{"enabled":false}}') as Record<string, unknown>;
    const proto = indexOf({ '/p': { get: { operationId: '__proto__' } } });
    expect(governanceImpact(diffEndpoints(proto, []), own).removedGoverned).toEqual([
      { key: '__proto__', governance: { enabled: false } },
    ]);
  });
});
