import {
  CATCH_ALL_DEPTH,
  CATCH_ALL_METHODS,
  buildCatchAllOperations,
  catchAllOperationId,
  catchAllPath,
} from './endpoint-operations';

const perOperation = { mockResponse: { enabled: true, code: 200, body: 'x' } };

describe('catch-all family (API-wide middleware hosted per operation)', () => {
  it('has nothing to host, so it emits nothing', () => {
    expect(buildCatchAllOperations({})).toEqual({ paths: {}, operations: {} });
  });

  it('names one path per depth, with a trailing-slash twin from depth 1', () => {
    expect(catchAllPath(0, false)).toBe('/');
    expect(catchAllPath(1, false)).toBe('/{wildcard}');
    expect(catchAllPath(1, true)).toBe('/{wildcard}/');
    expect(catchAllPath(3, false)).toBe('/{wildcard}/{wildcard2}/{wildcard3}');
  });

  it('keeps the pre-family operation id of the single-segment member', () => {
    expect(catchAllOperationId(1, 'GET', false)).toBe('catchAllGET');
    expect(catchAllOperationId(0, 'GET', false)).toBe('catchAllRootGET');
    expect(catchAllOperationId(2, 'POST', true)).toBe('catchAll2POSTSlash');
  });

  it('covers the bare path and every depth up to the ceiling, with and without a trailing slash', () => {
    const { paths, operations } = buildCatchAllOperations(perOperation);
    const expected = 1 + 2 * CATCH_ALL_DEPTH;
    expect(Object.keys(paths)).toHaveLength(expected);
    expect(Object.keys(operations)).toHaveLength(expected * CATCH_ALL_METHODS.length);
    expect(paths).toHaveProperty(['/']);
    expect(paths).toHaveProperty([catchAllPath(CATCH_ALL_DEPTH, true)]);
    expect(paths).not.toHaveProperty([catchAllPath(CATCH_ALL_DEPTH + 1, false)]);
  });

  it('declares every path parameter Tyk demands, uniquely per path', () => {
    const { paths } = buildCatchAllOperations(perOperation);
    for (const [path, item] of Object.entries(paths)) {
      const templated = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      const declared = ((item.parameters ?? []) as { name: string }[]).map((parameter) => parameter.name);
      expect(declared).toEqual(templated);
      expect(new Set(declared).size).toBe(declared.length);
    }
  });

  it('gives each operation its own copy of the middleware and a unique id', () => {
    const { paths, operations } = buildCatchAllOperations(perOperation);
    const ids = Object.values(paths).flatMap((item) =>
      CATCH_ALL_METHODS.map((method) => (item[method.toLowerCase()] as { operationId: string }).operationId),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(Object.keys(operations).sort());
    const mutated = operations.catchAllGET as Record<string, unknown>;
    mutated.mockResponse = 'changed';
    expect((operations.catchAll2GET as Record<string, unknown>).mockResponse).toEqual(perOperation.mockResponse);
  });

  it('publishes an API-wide request schema as the requestBody of every operation', () => {
    const schema = { type: 'object', required: ['sku'] };
    const { paths } = buildCatchAllOperations({ validateRequest: { enabled: true, errorResponseCode: 422 } }, schema);
    const post = paths['/{wildcard}/{wildcard2}'].post as { requestBody: { content: Record<string, { schema: unknown }> } };
    expect(post.requestBody.content['application/json'].schema).toEqual(schema);
  });
});
