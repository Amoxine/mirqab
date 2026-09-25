import {
  MAX_GOVERNANCE_BYTES,
  MAX_MANAGED_ENDPOINTS,
  MAX_VALIDATE_SCHEMA_BYTES,
  MAX_VALIDATE_SCHEMA_DEPTH,
  applyEndpointChange,
  governanceConfigPatch,
  governanceRevision,
  normaliseGovernance,
  orphansOf,
  readGovernanceState,
  stableStringify,
  validateSchemaProblem,
  type ChangeResult,
  type GovernanceState,
  type IndexedEndpoint,
} from './endpoint-governance';

const index: IndexedEndpoint[] = [
  { key: 'listOrders', method: 'GET', path: '/orders', tags: ['orders'] },
  { key: 'createOrder', method: 'POST', path: '/orders', tags: ['orders', 'write'] },
  { key: 'getOrder', method: 'GET', path: '/orders/{id}', tags: ['orders'] },
  { key: 'DELETE /orders/{id}', method: 'DELETE', path: '/orders/{id}', tags: [] },
];
const empty: GovernanceState = { endpoints: {}, restrictToSpec: false };

const ok = (result: ChangeResult): GovernanceState => {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.state;
};
const refused = (result: ChangeResult): string => {
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
};

describe('normaliseGovernance', () => {
  it('drops the two "clear" spellings and empty entries', () => {
    expect(normaliseGovernance({ enabled: true, auth: 'inherit' })).toBeNull();
    expect(normaliseGovernance({})).toBeNull();
    expect(normaliseGovernance({ enabled: false, auth: 'public' })).toEqual({ enabled: false, auth: 'public' });
  });

  it('L11: sorts and de-duplicates cacheResponseCodes, so equal behaviour has an equal revision', () => {
    expect(normaliseGovernance({ cache: { timeoutSeconds: 5, cacheResponseCodes: [404, 200, 200] } })).toEqual({
      cache: { timeoutSeconds: 5, cacheResponseCodes: [200, 404] },
    });
  });

  it('drops empty optional lists and undefined fields', () => {
    expect(
      normaliseGovernance({ cache: { timeoutSeconds: 5, cacheResponseCodes: [] }, mock: { code: 200, body: 'x', headers: [] }, timeoutSeconds: undefined }),
    ).toEqual({ cache: { timeoutSeconds: 5 }, mock: { code: 200, body: 'x' } });
  });
});

describe('readGovernanceState', () => {
  it('reads garbage as ungoverned rather than throwing', () => {
    expect(readGovernanceState({ endpoints: 'x', restrictToSpec: 'yes' })).toEqual(empty);
    expect(readGovernanceState({ endpoints: [1] })).toEqual(empty);
    expect(readGovernanceState({ endpoints: { a: null, b: { enabled: true }, c: { enabled: false } } }).endpoints).toEqual({
      c: { enabled: false },
    });
  });

  it('keeps a "__proto__" endpoint key as data (JSON.parse makes it an own property)', () => {
    const state = readGovernanceState(JSON.parse('{"endpoints":{"__proto__":{"enabled":false}}}') as { endpoints: unknown });
    expect(Object.keys(state.endpoints)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(state.endpoints)).toBe(Object.prototype);
  });
});

describe('governanceRevision', () => {
  it('ignores key order at every depth', () => {
    const a = { endpoints: { x: { rateLimit: { rate: 1, per: 2 }, auth: 'public' as const } }, restrictToSpec: false };
    const b = { restrictToSpec: false, endpoints: { x: { auth: 'public' as const, rateLimit: { per: 2, rate: 1 } } } };
    expect(governanceRevision(a)).toBe(governanceRevision(b));
    expect(governanceRevision(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('L11: folds the spec version in, so a spec re-upload makes an old revision stale', () => {
    expect(governanceRevision(empty, 1)).not.toBe(governanceRevision(empty, 2));
    expect(governanceRevision(empty, 3)).toBe(governanceRevision(empty, 3));
  });

  it('changes with any governed value and with restrictToSpec', () => {
    const base = governanceRevision(empty);
    expect(governanceRevision({ ...empty, restrictToSpec: true })).not.toBe(base);
    expect(governanceRevision({ endpoints: { x: { timeoutSeconds: 1 } }, restrictToSpec: false })).not.toBe(base);
  });

  it('stableStringify sorts keys and keeps array order', () => {
    expect(stableStringify({ b: [2, 1], a: { d: 1, c: null } })).toBe('{"a":{"c":null,"d":1},"b":[2,1]}');
  });
});

describe('validateSchemaProblem', () => {
  it('accepts a self-contained schema', () => {
    expect(validateSchemaProblem({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })).toBeNull();
  });

  it('refuses a $ref at any depth, including inside arrays', () => {
    expect(validateSchemaProblem({ $ref: '#/components/schemas/X' })).toMatch(/\$ref/);
    expect(validateSchemaProblem({ allOf: [{ properties: { a: { $ref: 'http://evil/x' } } }] })).toMatch(/\$ref/);
  });

  it('refuses an oversized schema', () => {
    expect(validateSchemaProblem({ description: 'x'.repeat(MAX_VALIDATE_SCHEMA_BYTES) })).toMatch(/larger/);
  });

  it.each([['$id'], ['$schema'], ['$anchor'], ['$dynamicRef'], ['$dynamicAnchor']])('L7: refuses the %s keyword at any depth', (keyword) => {
    expect(validateSchemaProblem({ properties: { a: { [keyword]: 'x' } } })).toMatch(new RegExp(`\\${keyword}`));
  });

  it('L7: refuses `type` given as an array, but not a property that is named "type"', () => {
    expect(validateSchemaProblem({ type: ['string', 'null'] })).toMatch(/type/);
    expect(validateSchemaProblem({ type: 'object', properties: { type: { type: 'string' } }, required: ['type'] })).toBeNull();
  });

  it('refuses a hostile depth without overflowing the stack, and accepts a sane one', () => {
    const nest = (levels: number): Record<string, unknown> => {
      let deep: Record<string, unknown> = { type: 'string' };
      for (let i = 1; i < levels; i += 1) deep = { not: deep };
      return deep;
    };
    expect(validateSchemaProblem(nest(20_000))).toMatch(/deeper/);
    expect(validateSchemaProblem(nest(MAX_VALIDATE_SCHEMA_DEPTH))).toBeNull();
    expect(validateSchemaProblem(nest(MAX_VALIDATE_SCHEMA_DEPTH + 1))).toMatch(/deeper/);
  });
});

describe('applyEndpointChange', () => {
  it('blocks one endpoint by key and leaves its siblings alone', () => {
    const state = ok(applyEndpointChange(empty, index, { keys: ['getOrder'], set: { enabled: false } }, false));
    expect(state.endpoints).toEqual({ getOrder: { enabled: false } });
  });

  it('targets exactly the endpoints of a tag', () => {
    const state = ok(applyEndpointChange(empty, index, { tag: 'orders', set: { timeoutSeconds: 3 } }, false));
    expect(Object.keys(state.endpoints).sort()).toEqual(['createOrder', 'getOrder', 'listOrders']);
  });

  it('merges control by control and clears with enabled:true / auth:inherit / clear', () => {
    let state = ok(applyEndpointChange(empty, index, { keys: ['listOrders'], set: { enabled: false, auth: 'public', timeoutSeconds: 2 } }, false));
    state = ok(applyEndpointChange(state, index, { keys: ['listOrders'], set: { rateLimit: { rate: 5, per: 10 } } }, false));
    expect(state.endpoints.listOrders).toEqual({ enabled: false, auth: 'public', timeoutSeconds: 2, rateLimit: { rate: 5, per: 10 } });
    state = ok(applyEndpointChange(state, index, { keys: ['listOrders'], set: { enabled: true, auth: 'inherit' }, clear: ['timeoutSeconds'] }, false));
    expect(state.endpoints.listOrders).toEqual({ rateLimit: { rate: 5, per: 10 } });
    state = ok(applyEndpointChange(state, index, { keys: ['listOrders'], clear: ['rateLimit'] }, false));
    expect(state.endpoints).toEqual({});
  });

  it('does not let an undefined field (DTO instance) wipe a stored control', () => {
    const blocked = ok(applyEndpointChange(empty, index, { keys: ['getOrder'], set: { enabled: false } }, false));
    const state = ok(applyEndpointChange(blocked, index, { keys: ['getOrder'], set: { enabled: undefined, timeoutSeconds: 4 } }, false));
    expect(state.endpoints.getOrder).toEqual({ enabled: false, timeoutSeconds: 4 });
  });

  it('refuses unknown keys, naming them', () => {
    expect(refused(applyEndpointChange(empty, index, { keys: ['nope', 'getOrder'], set: { enabled: false } }, false))).toMatch(/"nope"/);
  });

  it('refuses a tag nobody carries', () => {
    expect(refused(applyEndpointChange(empty, index, { tag: 'ghost', set: { enabled: false } }, false))).toMatch(/ghost/);
  });

  it('needs exactly one selector with set/clear, and something to do', () => {
    expect(refused(applyEndpointChange(empty, index, { set: { enabled: false } }, false))).toMatch(/exactly one/);
    expect(refused(applyEndpointChange(empty, index, { keys: ['getOrder'], tag: 'orders', set: { enabled: false } }, false))).toMatch(/exactly one/);
    expect(refused(applyEndpointChange(empty, index, {}, false))).toMatch(/Nothing/);
    expect(refused(applyEndpointChange(empty, index, { keys: ['getOrder'] }, false))).toMatch(/set or clear/);
    expect(refused(applyEndpointChange(empty, index, { keys: ['getOrder'], set: { timeoutSeconds: 1 }, clear: ['timeoutSeconds'] }, false))).toMatch(/Both/);
  });

  it('offers cache on GET only and validateRequestSchema on POST/PUT/PATCH only', () => {
    expect(refused(applyEndpointChange(empty, index, { keys: ['createOrder'], set: { cache: { timeoutSeconds: 5 } } }, false))).toMatch(/cache applies to GET/);
    expect(refused(applyEndpointChange(empty, index, { tag: 'orders', set: { validateRequestSchema: { type: 'object' } } }, false))).toMatch(/"listOrders"/);
    expect(ok(applyEndpointChange(empty, index, { keys: ['listOrders'], set: { cache: { timeoutSeconds: 5 } } }, false)).endpoints.listOrders).toEqual({ cache: { timeoutSeconds: 5 } });
    expect(ok(applyEndpointChange(empty, index, { keys: ['createOrder'], set: { validateRequestSchema: { type: 'object' } } }, false)).endpoints.createOrder).toBeDefined();
  });

  it('refuses per-endpoint cache while an API-wide cache exists', () => {
    expect(refused(applyEndpointChange(empty, index, { keys: ['listOrders'], set: { cache: { timeoutSeconds: 5 } } }, true))).toMatch(/API-wide cache/);
  });

  it('refuses a $ref in validateRequestSchema', () => {
    expect(refused(applyEndpointChange(empty, index, { keys: ['createOrder'], set: { validateRequestSchema: { $ref: '#/x' } } }, false))).toMatch(/\$ref/);
  });

  it('turns allow-list mode on and off, refusing an empty or oversized index', () => {
    const on = ok(applyEndpointChange(empty, index, { restrictToSpec: true }, false));
    expect(on.restrictToSpec).toBe(true);
    expect(ok(applyEndpointChange(on, index, { restrictToSpec: false }, false)).restrictToSpec).toBe(false);
    expect(refused(applyEndpointChange(empty, [], { restrictToSpec: true }, false))).toMatch(/specification/);
    const big = Array.from({ length: MAX_MANAGED_ENDPOINTS + 1 }, (_, i) => ({ key: `k${String(i)}`, method: 'GET', path: `/p${String(i)}`, tags: [] }));
    expect(refused(applyEndpointChange(empty, big, { restrictToSpec: true }, false))).toMatch(/at most/);
  });

  it('caps the number of governed endpoints', () => {
    const big = Array.from({ length: MAX_MANAGED_ENDPOINTS + 1 }, (_, i) => ({ key: `k${String(i)}`, method: 'GET', path: `/p${String(i)}`, tags: ['all'] }));
    expect(refused(applyEndpointChange(empty, big, { tag: 'all', set: { enabled: false } }, false))).toMatch(/At most/);
  });

  it('H2: caps the TOTAL stored size — one 60 KB schema fanned out to 500 endpoints is refused', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ key: `k${String(i)}`, method: 'POST', path: `/p${String(i)}`, tags: ['all'] }));
    const schema = { type: 'object', description: 'x'.repeat(60_000) };
    expect(refused(applyEndpointChange(empty, many, { tag: 'all', set: { validateRequestSchema: schema } }, false))).toMatch(
      new RegExp(String(MAX_GOVERNANCE_BYTES)),
    );
    // The same schema on a handful of endpoints is fine.
    expect(ok(applyEndpointChange(empty, many, { keys: ['k0', 'k1'], set: { validateRequestSchema: schema } }, false)).endpoints.k1).toBeDefined();
  });

  it('M5: refuses two governed endpoints that would route the same, naming both', () => {
    const clash: IndexedEndpoint[] = [
      { key: 'up', method: 'GET', path: '/Admin', tags: [] },
      { key: 'low', method: 'GET', path: '/admin', tags: [] },
      { key: 'x', method: 'GET', path: '/a/{x}', tags: [] },
      { key: 'y', method: 'GET', path: '/a/{y}', tags: [] },
    ];
    expect(refused(applyEndpointChange(empty, clash, { keys: ['up', 'low'], set: { enabled: false } }, false))).toMatch(/"up".*"low"/);
    expect(refused(applyEndpointChange(empty, clash, { keys: ['x', 'y'], set: { enabled: false } }, false))).toMatch(/"x".*"y"/);
    // One of a pair is fine; allow-list mode selects them all and is refused.
    expect(ok(applyEndpointChange(empty, clash, { keys: ['up', 'x'], set: { enabled: false } }, false))).toBeDefined();
    expect(refused(applyEndpointChange(empty, clash, { restrictToSpec: true }, false))).toMatch(/route the same/);
  });

  it.each([
    ['/a/{}'],
    ['/a/{x}/b/{x}'],
    ['/a:b'],
    ['/a?x=1'],
    ['/a#b'],
    ['/{{x}}'],
    ['/a/{x'],
    ['/a/x}'],
  ])('L7: refuses to govern an endpoint whose path template the gateway cannot take: %s', (path) => {
    const bad: IndexedEndpoint[] = [{ key: 'bad', method: 'GET', path, tags: [] }];
    expect(refused(applyEndpointChange(empty, bad, { keys: ['bad'], set: { enabled: false } }, false))).toMatch(/"bad"/);
  });

  it('L7: accepts a well-formed template, and a bad template that is not selected', () => {
    const idx: IndexedEndpoint[] = [
      { key: 'good', method: 'GET', path: '/a/{x}/b/{y}', tags: [] },
      { key: 'bad', method: 'GET', path: '/a/{}', tags: [] },
    ];
    expect(ok(applyEndpointChange(empty, idx, { keys: ['good'], set: { enabled: false } }, false)).endpoints.good).toEqual({ enabled: false });
  });

  it('keeps orphans until dropOrphans, and reports them', () => {
    const withOrphan: GovernanceState = { endpoints: { gone: { enabled: false }, getOrder: { auth: 'public' } }, restrictToSpec: false };
    expect(orphansOf(withOrphan, index)).toEqual([{ key: 'gone', governance: { enabled: false } }]);
    const edited = ok(applyEndpointChange(withOrphan, index, { keys: ['listOrders'], set: { enabled: false } }, false));
    expect(edited.endpoints.gone).toEqual({ enabled: false });
    const dropped = ok(applyEndpointChange(withOrphan, index, { dropOrphans: true }, false));
    expect(dropped.endpoints).toEqual({ getOrder: { auth: 'public' } });
  });

  it('keeps a hostile "__proto__" key as data', () => {
    const hostile: IndexedEndpoint[] = [{ key: '__proto__', method: 'GET', path: '/x', tags: [] }];
    const state = ok(applyEndpointChange(empty, hostile, { keys: ['__proto__'], set: { enabled: false } }, false));
    expect(Object.keys(state.endpoints)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(state.endpoints)).toBe(Object.prototype);
  });

  it('does not mutate the state it was given', () => {
    const before: GovernanceState = { endpoints: { getOrder: { enabled: false } }, restrictToSpec: false };
    const copy = JSON.parse(JSON.stringify(before)) as GovernanceState;
    ok(applyEndpointChange(before, index, { keys: ['getOrder'], set: { enabled: true } }, false));
    expect(before).toEqual(copy);
  });
});

describe('governanceConfigPatch', () => {
  it('stores nothing for an ungoverned API', () => {
    expect(governanceConfigPatch(empty)).toEqual({});
    expect(governanceConfigPatch({ endpoints: { a: { enabled: false } }, restrictToSpec: true })).toEqual({
      endpoints: { a: { enabled: false } },
      restrictToSpec: true,
    });
  });
});
