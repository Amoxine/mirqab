import { buildEndpointIndex, contentHashOf, expandServerUrl, listServers, MAX_ENDPOINTS, MAX_SERVERS } from './oas-endpoints';

const ok = { description: 'ok' };

describe('buildEndpointIndex', () => {
  it('returns one row per path+method, in document order, with upper-case methods', () => {
    const { endpoints, overflow } = buildEndpointIndex({
      paths: {
        '/orders': { get: { operationId: 'listOrders', responses: { 200: ok } }, post: { operationId: 'createOrder' } },
        '/orders/{id}': { get: { operationId: 'getOrder' }, delete: {} },
      },
    });

    expect(overflow).toBe(false);
    expect(endpoints.map((e) => `${e.method} ${e.path}`)).toEqual([
      'GET /orders',
      'POST /orders',
      'GET /orders/{id}',
      'DELETE /orders/{id}',
    ]);
  });

  it('uses the operationId as the key when it is unique, else "METHOD path"', () => {
    const { endpoints } = buildEndpointIndex({
      paths: {
        '/a': { get: { operationId: 'same' }, post: { operationId: 'unique' } },
        '/b': { get: { operationId: 'same' }, put: {} },
      },
    });

    expect(endpoints.map((e) => e.key)).toEqual(['GET /a', 'unique', 'GET /b', 'PUT /b']);
    expect(endpoints[0]?.operationId).toBe('same');
  });

  it('keeps every key unique even when an operationId collides with a synthesised key', () => {
    const { endpoints } = buildEndpointIndex({
      paths: { '/a': { get: {}, post: { operationId: 'GET /a' } } },
    });

    expect(new Set(endpoints.map((e) => e.key)).size).toBe(2);
  });

  it('ignores non-method keys on a path item (parameters, summary, servers, x- extensions)', () => {
    const { endpoints } = buildEndpointIndex({
      paths: { '/a': { summary: 's', parameters: [], servers: [], 'x-foo': { get: {} }, get: {} } },
    });

    expect(endpoints).toHaveLength(1);
  });

  it('skips a malformed operation instead of throwing', () => {
    const { endpoints } = buildEndpointIndex({ paths: { '/a': { get: 'nope', post: null, put: [] }, '/b': 'x', '/c': null } });

    expect(endpoints).toEqual([]);
  });

  it('follows a LOCAL path-item $ref, and never an external or circular one', () => {
    const { endpoints } = buildEndpointIndex({
      paths: {
        '/a': { $ref: '#/components/pathItems/Shared' },
        '/b': { $ref: 'http://evil.invalid/x' },
        '/c': { $ref: '#/paths/~1c' },
        '/d': { $ref: '#/components/pathItems/__proto__' },
      },
      components: { pathItems: { Shared: { get: { operationId: 'shared' } } } },
    });

    expect(endpoints.map((e) => e.key)).toEqual(['shared']);
  });

  it('reads security from the operation, falling back to the document; an empty list clears it', () => {
    const { endpoints } = buildEndpointIndex({
      security: [{ apiKey: [] }],
      paths: {
        '/inherit': { get: {} },
        '/own': { get: { security: [{ oauth: ['read'] }, { basic: [] }] } },
        '/public': { get: { security: [] } },
      },
    });

    expect(endpoints.map((e) => e.securitySchemes)).toEqual([['apiKey'], ['basic', 'oauth'], []]);
  });

  it('takes the summary, else the first description line, capped at 200 characters; tags must be strings', () => {
    const long = 'x'.repeat(300);
    const { endpoints } = buildEndpointIndex({
      paths: {
        '/a': { get: { summary: '  List things  ', description: 'ignored' } },
        '/b': { get: { description: `First line\nsecond line` } },
        '/c': { get: { summary: long, tags: ['t1', 5, null, 't2'], deprecated: true } },
        '/d': { get: {} },
      },
    });

    expect(endpoints.map((e) => e.summary)).toEqual(['List things', 'First line', 'x'.repeat(200), null]);
    expect(endpoints[2]).toMatchObject({ tags: ['t1', 't2'], deprecated: true });
    expect(endpoints[0]?.deprecated).toBe(false);
  });

  it.each([null, undefined, 'a string', 42, [], { paths: null }, { paths: [] }, {}])('returns nothing for %j', (doc) => {
    expect(buildEndpointIndex(doc)).toEqual({ endpoints: [], overflow: false });
  });

  it('stops at the endpoint limit and reports the overflow', () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < MAX_ENDPOINTS + 1; i += 1) paths[`/p${String(i)}`] = { get: {} };

    const { endpoints, overflow } = buildEndpointIndex({ paths });

    expect(overflow).toBe(true);
    expect(endpoints).toHaveLength(MAX_ENDPOINTS);
  });

  it('accepts a document with exactly the limit', () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < MAX_ENDPOINTS; i += 1) paths[`/p${String(i)}`] = { get: {} };

    expect(buildEndpointIndex({ paths })).toMatchObject({ overflow: false });
  });
});

describe('expandServerUrl', () => {
  it('returns a plain URL unchanged', () => {
    expect(expandServerUrl({ url: 'https://api.example.com/v1' })).toBe('https://api.example.com/v1');
  });

  it('substitutes declared defaults, including several variables and a repeat', () => {
    const server = {
      url: '{scheme}://{env}.example.com/{env}',
      variables: { scheme: { default: 'https' }, env: { default: 'prod', enum: ['prod', 'stg'] } },
    };

    expect(expandServerUrl(server)).toBe('https://prod.example.com/prod');
  });

  it.each([
    ['a variable with no declaration', { url: 'https://{env}.example.com' }],
    ['a variable with no default', { url: 'https://{env}.example.com', variables: { env: {} } }],
    ['a non-string default', { url: 'https://{env}.example.com', variables: { env: { default: 5 } } }],
    ['an inherited property name', { url: 'https://{constructor}.example.com', variables: {} }],
    ['a missing url', { variables: {} }],
    ['a non-object server', 'https://x'],
  ])('returns null for %s', (_label, server) => {
    expect(expandServerUrl(server)).toBeNull();
  });
});

describe('listServers', () => {
  it('lists every server with its index', () => {
    expect(listServers({ servers: [{ url: 'https://a.example.com' }, { url: '{x}' }] })).toEqual([
      { index: 0, url: 'https://a.example.com' },
      { index: 1, url: null },
    ]);
  });

  it('caps the list and tolerates a missing or malformed servers field', () => {
    const servers = Array.from({ length: MAX_SERVERS + 10 }, () => ({ url: 'https://a.example.com' }));

    expect(listServers({ servers })).toHaveLength(MAX_SERVERS);
    expect(listServers({})).toEqual([]);
    expect(listServers({ servers: 'x' })).toEqual([]);
    expect(listServers(null)).toEqual([]);
  });
});

describe('contentHashOf', () => {
  it('is the SHA-256 hex of the text (known vector)', () => {
    expect(contentHashOf('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('differs for different text and is stable for the same text', () => {
    expect(contentHashOf('a')).not.toBe(contentHashOf('b'));
    expect(contentHashOf('same')).toBe(contentHashOf('same'));
  });
});
