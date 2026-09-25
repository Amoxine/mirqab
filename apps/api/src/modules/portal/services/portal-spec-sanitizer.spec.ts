import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  blockedEndpointKeys,
  MAX_SANITIZE_DEPTH,
  MAX_SANITIZE_NODES,
  sanitizePortalSpec,
} from './portal-spec-sanitizer';

const SERVER_URL = '/acme/orders';
const OPTIONS = { serverUrl: SERVER_URL };

type Doc = Record<string, unknown>;

/** A document the sanitizer must accept, that says nothing the sanitizer may touch. */
function legitimateDocument(): Doc {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Orders',
      version: '2.1.0',
      description: 'Line one.\nLine two with **markdown**, "quotes", ünïcödé and 日本語.',
      'x-logo': { url: 'https://cdn.example.com/logo.png' },
    },
    tags: [{ name: 'orders', description: 'Everything about orders' }],
    paths: {
      '/orders': {
        parameters: [{ name: 'trace', in: 'header', schema: { type: 'string' } }],
        get: {
          operationId: 'listOrders',
          summary: 'List orders',
          tags: ['orders'],
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }],
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } },
            },
          },
        },
        post: {
          operationId: 'createOrder',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' }, example: { id: 7, note: null, paid: false, ratio: 0.5 } } },
          },
          responses: { '201': { description: 'Created' } },
        },
      },
      '/orders/{id}': {
        get: { operationId: 'getOrder', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
        delete: { operationId: 'deleteOrder', responses: { '204': { description: 'Deleted' } } },
      },
    },
    components: {
      schemas: {
        Order: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer' }, note: { type: 'string', nullable: true, enum: ['a', 'b', null] } },
        },
      },
      securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } },
    },
    security: [{ key: [] }],
  };
}

const sanitize = (doc: unknown, options: Parameters<typeof sanitizePortalSpec>[1] = OPTIONS): Doc => {
  const out = sanitizePortalSpec(doc, options);
  if (out === null) throw new Error('expected a sanitized document, got null');
  return out;
};

const wire = (value: unknown): string => JSON.stringify(value);

describe('sanitizePortalSpec — what survives', () => {
  it('leaves legitimate content byte-for-byte and adds only the gateway server', () => {
    const input = legitimateDocument();

    const out = sanitize(input);

    expect(wire(out)).toBe(wire({ ...legitimateDocument(), servers: [{ url: SERVER_URL }] }));
  });

  it('keeps hostile-looking TEXT as the same string: rendering it as plain text is the web\'s job', () => {
    const description = '<script>alert(1)</script> [x](javascript:alert(1)) <img src=x onerror=alert(1)>';
    const doc = { openapi: '3.0.3', paths: { '/a': { get: { summary: description, description, responses: {} } } } };

    const out = sanitize(doc);

    expect(out.paths).toEqual(doc.paths);
  });

  it('keeps local $refs, and a schema PROPERTY that happens to be called $ref', () => {
    const doc = {
      paths: {},
      components: { schemas: { A: { $ref: '#/components/schemas/B' }, C: { properties: { $ref: { type: 'string' } } } } },
    };

    expect(sanitize(doc).components).toEqual(doc.components);
  });

  it('does not mutate its input (a frozen document is fine)', () => {
    const input = legitimateDocument();
    (input.info as Doc)['x-tyk-note'] = 'x';
    input.servers = [{ url: 'http://internal.corp' }];
    const before = wire(input);
    const freeze = (value: unknown): void => {
      if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.values(value).forEach(freeze);
      }
    };
    freeze(input);

    sanitize(input);

    expect(wire(input)).toBe(before);
  });
});

describe('sanitizePortalSpec — servers', () => {
  it('replaces every document-, path-, operation-, callback- and link-level server with the one gateway URL', () => {
    const server = (url: string) => ({ url, description: 'do not publish' });
    const doc = {
      openapi: '3.0.3',
      servers: [server('http://root-1.internal.corp'), server('https://root-2.internal.corp/{env}')],
      paths: {
        '/a': {
          servers: [server('http://path-level.internal.corp')],
          get: {
            servers: [server('http://operation-level.internal.corp')],
            responses: {
              '200': { description: 'OK', links: { next: { operationId: 'x', server: server('http://link.internal.corp') } } },
            },
            callbacks: { onEvent: { '{$request.body#/url}': { post: { servers: [server('http://callback.internal.corp')] } } } },
          },
        },
      },
    };

    const out = sanitize(doc);

    expect(out.servers).toEqual([{ url: SERVER_URL }]);
    expect(wire(out)).not.toContain('internal.corp');
    expect(wire(out)).not.toContain('do not publish');
  });

  it.each([
    ['a string', 'http://internal.corp'],
    ['an object', { url: 'http://internal.corp' }],
    ['null', null],
  ])('replaces a malformed document-level `servers` (%s) too', (_label, servers) => {
    const out = sanitize({ openapi: '3.0.3', servers, paths: {} });

    expect(out.servers).toEqual([{ url: SERVER_URL }]);
    expect(wire(out)).not.toContain('internal.corp');
  });

  it('drops nested `servers` however malformed: an array with a bad element, an object, at path and operation level', () => {
    const doc = {
      openapi: '3.0.3',
      paths: {
        '/a': {
          servers: [{ url: 'http://10.0.0.5/leak' }, {}],
          get: { servers: { url: 'http://10.0.0.6/leak' }, responses: {} },
          post: { servers: ['http://10.0.0.7/leak'], responses: {} },
          put: { servers: [null, 42], responses: {} },
        },
      },
      components: { links: { L: { server: { description: 'no url, still a server object', variables: { h: { default: '10.0.0.8' } } } } } },
    };

    const out = sanitize(doc);

    expect(wire(out)).not.toContain('10.0.0.');
    expect(wire(out)).not.toContain('"servers":[{"url":"http');
    expect(((out.paths as Doc)['/a'] as Doc).servers).toBeUndefined();
    expect((((out.paths as Doc)['/a'] as Doc).get as Doc).servers).toBeUndefined();
    expect(((out.components as Doc).links as Doc).L).toEqual({});
  });

  it('keeps a schema property NAMED servers, but not a property named "properties" hiding a server list', () => {
    const properties = { servers: { type: 'array' }, server: { type: 'string' } };
    const out = sanitize({
      paths: {},
      components: {
        schemas: {
          Cfg: { type: 'object', properties },
          Trick: { type: 'object', properties: { properties: { servers: [{ host: '10.0.0.9' }], server: { host: '10.0.0.9' } } } },
          ArrayNamedServers: { type: 'object', properties: { servers: [{ host: '10.0.0.9' }] } },
        },
      },
    });

    const schemas = (out.components as Doc).schemas as Doc;
    expect((schemas.Cfg as Doc).properties).toEqual(properties);
    expect(wire(schemas.Trick)).not.toContain('10.0.0.9');
    expect(wire(schemas.ArrayNamedServers)).not.toContain('10.0.0.9');
  });

  it('keeps a schema property that is merely NAMED servers or server', () => {
    const properties = { servers: { type: 'array', items: { type: 'string' } }, server: { type: 'string' } };
    const out = sanitize({ paths: {}, components: { schemas: { Cfg: { type: 'object', properties } } } });

    expect((out.components as Doc).schemas).toEqual({ Cfg: { type: 'object', properties } });
  });
});

describe('sanitizePortalSpec — x-tyk-* and other gateway internals', () => {
  it('removes x-tyk-* at every depth (document, path, operation, schema, example, array) and keeps other extensions', () => {
    const doc = {
      openapi: '3.0.3',
      'x-tyk-api-gateway': { upstream: { url: 'http://proxy.internal.corp:8443' } },
      'x-keep-me': { fine: true },
      paths: {
        '/a': {
          'x-tyk-path': 1,
          get: { 'X-Tyk-Operation': { block: true }, 'x-vendor': 'kept', responses: {} },
        },
      },
      components: {
        schemas: {
          S: { type: 'object', 'x-tyk-schema': 'secret', example: { 'x-tyk-in-example': 'secret', nested: [{ 'x-tyk-in-array': 'secret', ok: 1 }] } },
        },
      },
    };

    const out = sanitize(doc);

    expect(wire(out).toLowerCase()).not.toContain('x-tyk');
    expect(wire(out)).not.toContain('proxy.internal.corp');
    expect(wire(out)).not.toContain('secret');
    expect(out['x-keep-me']).toEqual({ fine: true });
    expect(((out.paths as Doc)['/a'] as Doc).get).toEqual({ 'x-vendor': 'kept', responses: {} });
    expect((((out.components as Doc).schemas as Doc).S as Doc).example).toEqual({ nested: [{ ok: 1 }] });
  });
});

describe('sanitizePortalSpec — external $ref is never followed', () => {
  it.each([
    'http://127.0.0.1:1/x',
    'https://evil.example/schema.json#/Foo',
    'file:///etc/hostname',
    '../../etc/hostname',
    './local.yaml#/A',
    '//evil.example/x',
    'HTTP://EVIL.EXAMPLE/x',
    'other.json',
  ])('drops the $ref %s and keeps its siblings', (ref) => {
    const doc = { paths: { '/a': { get: { responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: ref, description: 'sibling' } } } } } } } } };

    const out = sanitize(doc);

    expect(wire(out)).not.toContain(ref);
    expect(wire(out)).toContain('sibling');
  });

  it('opens no connection while sanitizing (a loopback listener sees zero)', async () => {
    let connections = 0;
    const server = http.createServer((_req, res) => res.end());
    server.on('connection', () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    try {
      sanitize({ paths: {}, components: { schemas: { A: { $ref: `http://127.0.0.1:${String(port)}/x` } } } });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(connections).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('sanitizePortalSpec — JSON Schema keywords that move the base URI or point outside the document', () => {
  const schemaWith = (schema: Doc): Doc => ({ openapi: '3.1.0', paths: {}, components: { schemas: { S: schema } } });
  const schemaOf = (out: Doc): Doc => ((out.components as Doc).schemas as Doc).S as Doc;

  it.each([
    ['an absolute $id', { $id: 'https://evil.example/schemas/s', type: 'object' }],
    ['a scheme-relative $id', { $id: '//evil.example/s', type: 'object' }],
    ['an absolute $schema', { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }],
    ['a file: $id', { $id: 'file:///etc/hostname', type: 'object' }],
    ['a remote $dynamicRef', { $dynamicRef: 'https://evil.example/meta#node', type: 'object' }],
    ['a relative-file $dynamicRef', { $dynamicRef: 'other.json#node', type: 'object' }],
    ['a remote $recursiveRef', { $recursiveRef: 'http://evil.example/x', type: 'object' }],
  ])('drops %s and keeps the rest of the schema', (_label, schema) => {
    const out = schemaOf(sanitize(schemaWith({ ...schema, description: 'sibling' })));

    expect(out).toEqual({ type: 'object', description: 'sibling' });
  });

  it('keeps fragment-only $dynamicRef / $recursiveRef and a property that is merely NAMED $id or $schema', () => {
    const schema = {
      $dynamicRef: '#meta',
      $recursiveRef: '#',
      properties: { $id: { type: 'string' }, $schema: { type: 'string' } },
    };

    expect(schemaOf(sanitize(schemaWith(schema)))).toEqual(schema);
  });

  it('drops the root jsonSchemaDialect (a URI), but only at the root', () => {
    const out = sanitize({ openapi: '3.1.0', jsonSchemaDialect: 'https://evil.example/dialect', paths: {}, 'x-vendor': { jsonSchemaDialect: 'kept' } });

    expect(out.jsonSchemaDialect).toBeUndefined();
    expect(out['x-vendor']).toEqual({ jsonSchemaDialect: 'kept' });
  });
});

describe('sanitizePortalSpec — prototype keys', () => {
  it('drops __proto__, constructor and prototype at any depth and pollutes nothing', () => {
    // JSON.parse makes `__proto__` an OWN property, exactly what an uploaded file produces.
    const doc = JSON.parse(
      '{"openapi":"3.0.3","__proto__":{"polluted":"root"},"constructor":{"prototype":{"polluted":"ctor"}},' +
        '"paths":{"/a":{"get":{"responses":{},"__proto__":{"polluted":"op"}}}},' +
        '"components":{"schemas":{"S":{"type":"object","prototype":{"polluted":"proto"},"example":[{"__proto__":{"polluted":"deep"}}]}}}}',
    ) as Doc;

    const out = sanitize(doc);

    expect(wire(out)).not.toContain('polluted');
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Doc).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});

describe('sanitizePortalSpec — bounded work and unusable input', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '{"openapi":"3.0.3"}'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', [{ openapi: '3.0.3' }]],
    ['a function', () => ({})],
    ['a Map', new Map([['paths', {}]])],
    ['a Date', new Date(0)],
  ])('answers null for %s', (_label, input) => {
    expect(sanitizePortalSpec(input, OPTIONS)).toBeNull();
  });

  it('answers null, not a stack overflow, for a document nested far past the depth limit', () => {
    const root: Doc = { paths: {} };
    let node: Doc = root;
    for (let i = 0; i < 100_000; i += 1) {
      const child: Doc = {};
      node.a = child;
      node = child;
    }

    expect(sanitizePortalSpec(root, OPTIONS)).toBeNull();
  });

  it('accepts nesting up to the depth limit and refuses one level more', () => {
    const nest = (levels: number): Doc => {
      const root: Doc = {};
      let node: Doc = root;
      for (let i = 1; i < levels; i += 1) {
        const child: Doc = {};
        node.a = child;
        node = child;
      }
      return root;
    };

    expect(sanitizePortalSpec(nest(MAX_SANITIZE_DEPTH), OPTIONS)).not.toBeNull();
    expect(sanitizePortalSpec(nest(MAX_SANITIZE_DEPTH + 1), OPTIONS)).toBeNull();
  });

  it('answers null for a document with more nodes than the work limit, and accepts a large legitimate one', () => {
    const huge: Doc = { paths: {}, 'x-big': new Array<number>(MAX_SANITIZE_NODES + 1).fill(0) };
    const large: Doc = { paths: {}, 'x-big': new Array<number>(100_000).fill(0) };

    expect(sanitizePortalSpec(huge, OPTIONS)).toBeNull();
    expect(sanitizePortalSpec(large, OPTIONS)).not.toBeNull();
  }, 30_000);

  it('drops values JSON cannot carry instead of passing them through', () => {
    const out = sanitize({ paths: {}, 'x-a': undefined, 'x-b': () => 1, 'x-c': new Date(0), 'x-d': [1, undefined, () => 2] });

    expect(out).toEqual({ paths: {}, 'x-d': [1, null, null], servers: [{ url: SERVER_URL }] });
  });
});

describe('sanitizePortalSpec — operations blocked by endpoint governance', () => {
  const doc = (): Doc => ({
    openapi: '3.0.3',
    paths: {
      '/pets': { get: { operationId: 'listPets', responses: {} }, post: { operationId: 'createPet', responses: {} } },
      '/orders/{id}': { get: { responses: {} }, delete: { responses: {} }, parameters: [{ name: 'id', in: 'path' }] },
      '/admin': { get: { operationId: 'adminOnly' } },
    },
  });
  const blocked = (...keys: string[]) => ({ serverUrl: SERVER_URL, blockedKeys: new Set(keys) });

  it('removes only the blocked operations (keys are operationId, else "METHOD path")', () => {
    const paths = sanitize(doc(), blocked('createPet', 'DELETE /orders/{id}')).paths as Doc;

    expect(Object.keys(paths['/pets'] as Doc)).toEqual(['get']);
    expect(Object.keys(paths['/orders/{id}'] as Doc)).toEqual(['get', 'parameters']);
  });

  it('removes a path item once none of its operations is left', () => {
    const paths = sanitize(doc(), blocked('adminOnly')).paths as Doc;

    expect(Object.keys(paths)).toEqual(['/pets', '/orders/{id}']);
  });

  it('uses "METHOD path" when an operationId is not unique, exactly like the stored index', () => {
    const twin: Doc = { paths: { '/a': { get: { operationId: 'dup' } }, '/b': { get: { operationId: 'dup' } } } };

    const byId = sanitize(twin, blocked('dup')).paths as Doc;
    const byRoute = sanitize(twin, blocked('GET /a')).paths as Doc;

    expect(Object.keys(byId)).toEqual(['/a', '/b']);
    expect(Object.keys(byRoute)).toEqual(['/b']);
  });

  it('hides a whole path item that is a local $ref when one of its operations is blocked (it cannot be edited in place)', () => {
    const shared: Doc = {
      paths: { '/p': { $ref: '#/components/pathItems/P' } },
      components: { pathItems: { P: { get: { operationId: 'getP' }, put: { operationId: 'putP' } } } },
    };

    const paths = sanitize(shared, blocked('putP')).paths as Doc;

    expect(paths).toEqual({});
  });

  describe('a blocked operation behind a path-item $ref', () => {
    const pathItems = (): Doc => ({
      openapi: '3.1.0',
      paths: {
        '/a': { $ref: '#/components/pathItems/A' },
        '/b': { $ref: '#/components/pathItems/A' },
        '/c': { get: { operationId: 'getC' } },
      },
      components: {
        schemas: { Keep: { type: 'object' } },
        pathItems: { A: { get: { operationId: 'getA' }, post: { operationId: 'postA' } }, Other: { get: {} } },
      },
    });
    const itemsOf = (out: Doc): string[] => Object.keys((out.components as Doc).pathItems as Doc);

    it('removes the shared target too once no path item references it any more', () => {
      const out = sanitize(pathItems(), blocked('GET /a', 'GET /b'));

      expect(Object.keys(out.paths as Doc)).toEqual(['/c']);
      expect(itemsOf(out)).toEqual(['Other']);
      expect(wire(out)).not.toContain('postA');
      expect((out.components as Doc).schemas).toEqual({ Keep: { type: 'object' } });
    });

    it('keeps the target while another path item still references it', () => {
      const out = sanitize(pathItems(), blocked('GET /a'));

      expect(Object.keys(out.paths as Doc)).toEqual(['/b', '/c']);
      expect(itemsOf(out)).toEqual(['A', 'Other']);
    });

    it('follows a chain of path-item refs (paths -> A -> B) and removes both links', () => {
      const chain: Doc = {
        openapi: '3.1.0',
        paths: { '/a': { $ref: '#/components/pathItems/A' } },
        components: { pathItems: { A: { $ref: '#/components/pathItems/B' }, B: { get: { operationId: 'getB' } }, Other: {} } },
      };

      const out = sanitize(chain, blocked('getB'));

      expect(out.paths).toEqual({});
      expect(itemsOf(out)).toEqual(['Other']);
      expect(wire(out)).not.toContain('getB');
    });

    it('never deletes anything outside #/components/ (a ref to another path item is left alone)', () => {
      const doc: Doc = { paths: { '/a': { $ref: '#/paths/~1b' }, '/b': { get: { operationId: 'getB' } } } };

      const out = sanitize(doc, blocked('GET /a'));

      expect(Object.keys(out.paths as Doc)).toEqual(['/b']);
      expect(wire(out.paths)).toContain('getB');
    });
  });

  it('ignores a blocked key that names no endpoint, and changes nothing when nothing is blocked', () => {
    expect(sanitize(doc(), blocked('nope')).paths).toEqual(doc().paths);
    expect(sanitize(doc()).paths).toEqual(doc().paths);
  });
});

describe('blockedEndpointKeys', () => {
  it('collects the keys whose governance says enabled:false', () => {
    const config = { endpoints: { a: { enabled: false }, b: { rateLimit: { rate: 1, per: 60 } }, c: { enabled: false, auth: 'public' } } };

    expect([...blockedEndpointKeys(config)]).toEqual(['a', 'c']);
  });

  it.each([
    ['null', null],
    ['no endpoints', {}],
    ['endpoints as an array', { endpoints: [{ enabled: false }] }],
    ['endpoints as a string', { endpoints: 'nope' }],
    ['a non-object entry', { endpoints: { a: 'off', b: null, c: 0 } }],
    ['enabled as the string "false"', { endpoints: { a: { enabled: 'false' } } }],
    ['enabled:true', { endpoints: { a: { enabled: true } } }],
  ])('is empty for %s', (_label, config) => {
    expect(blockedEndpointKeys(config).size).toBe(0);
  });
});
