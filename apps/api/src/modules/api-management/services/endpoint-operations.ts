/**
 * The OpenAPI operations `mapToTykOas` puts into a Tyk-OAS definition.
 *
 * Tyk offers circuit breaker, URL rewrite, mock, body transforms and request validation ONLY per
 * operation (`x-tyk-api-gateway.middleware.operations.<operationId>`). An API-wide setting is therefore
 * hosted on synthetic "catch-all" operations. Measured on Tyk OSS 5.15.0 (docs/OAS-ENDPOINT-CAPABILITIES.md):
 *
 *  - `{wildcard}` matches exactly ONE path segment. A lone `/{wildcard}` operation is silently absent for
 *    `/a/b`, `/a/b/c` and the bare listen path — so an API-wide breaker or mock only ever reached
 *    single-segment paths. Hence a FAMILY of catch-alls, one per depth.
 *  - A trailing slash is a different path: `/x/` does not match `/x` or `/{wildcard}`. Every catch-all
 *    therefore has a trailing-slash twin.
 *  - Regex path templates (`/{wildcard:.*}`) are rejected by the gateway.
 *  - A REAL operation always wins over a templated one, at every depth.
 */

/** Methods an API-wide middleware entry is expanded across (neither Tyk format has an "any method" form). */
export const CATCH_ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * How many path segments deep the API-wide catch-alls reach. ponytail: a ceiling, not a guarantee — an
 * undeclared path deeper than this skips API-wide breaker/rewrite/mock/transform/validation. Raising it
 * costs `(2 * depth + 1) * 5` operations per API that uses any of them.
 */
export const CATCH_ALL_DEPTH = 8;

export type PathItem = Record<string, unknown>;

export interface OperationsDocument {
  paths: Record<string, PathItem>;
  /** `middleware.operations`, keyed by operationId. */
  operations: Record<string, unknown>;
}

const wildcardName = (position: number): string => (position === 1 ? 'wildcard' : `wildcard${String(position)}`);

/** `depth` 0 is the bare listen path; depth n is n templated segments. */
export function catchAllPath(depth: number, trailingSlash: boolean): string {
  if (depth === 0) return '/';
  const segments = Array.from({ length: depth }, (_, index) => `{${wildcardName(index + 1)}}`);
  return `/${segments.join('/')}${trailingSlash ? '/' : ''}`;
}

/**
 * `catchAllGET` (depth 1) keeps the name it had before the family existed; the rest are new.
 * A trailing-slash twin appends `Slash`.
 */
export function catchAllOperationId(depth: number, method: string, trailingSlash: boolean): string {
  const base = depth === 0 ? `catchAllRoot${method}` : depth === 1 ? `catchAll${method}` : `catchAll${String(depth)}${method}`;
  return trailingSlash ? `${base}Slash` : base;
}

/**
 * Every synthetic catch-all path with `perOperation` on each method. Empty when there is nothing to host.
 *
 * `validateRequestSchema` is published as the operation's `requestBody` (Tyk validates against the
 * document itself), exactly as the single catch-all did before.
 */
export function buildCatchAllOperations(
  perOperation: Record<string, unknown>,
  validateRequestSchema?: Record<string, unknown> | null,
): OperationsDocument {
  const paths: Record<string, PathItem> = {};
  const operations: Record<string, unknown> = {};
  if (Object.keys(perOperation).length === 0) return { paths, operations };

  for (let depth = 0; depth <= CATCH_ALL_DEPTH; depth += 1) {
    // Depth 0 is `/`, which already ends in a slash: it has no twin.
    for (const trailingSlash of depth === 0 ? [false] : [false, true]) {
      const pathItem: PathItem =
        depth === 0
          ? {}
          : {
              parameters: Array.from({ length: depth }, (_, index) => ({
                name: wildcardName(index + 1),
                in: 'path',
                required: true,
                schema: { type: 'string' },
              })),
            };
      for (const method of CATCH_ALL_METHODS) {
        const operationId = catchAllOperationId(depth, method, trailingSlash);
        pathItem[method.toLowerCase()] = {
          operationId,
          responses: { '200': { description: 'ok' } },
          ...(validateRequestSchema
            ? { requestBody: { required: true, content: { 'application/json': { schema: validateRequestSchema } } } }
            : {}),
        };
        operations[operationId] = { ...perOperation };
      }
      paths[catchAllPath(depth, trailingSlash)] = pathItem;
    }
  }
  return { paths, operations };
}
