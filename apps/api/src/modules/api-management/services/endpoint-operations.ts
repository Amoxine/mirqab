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

import type { EndpointGovernance } from './endpoint-governance';

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

// ── OAS-03: real operations for governed endpoints ────────────────────────────────────────────────

/** One row of the stored spec index, as the mapper needs it. Its position in the index names its operation. */
export interface EndpointRef {
  key: string;
  method: string;
  path: string;
}

/** Methods a real operation may be emitted for (lower-cased as OpenAPI path-item keys). */
export const REAL_OPERATION_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'] as const;

/** `og_ep<index position>`: never a user-supplied operationId, so it cannot collide with `catchAll*`. */
export const realOperationId = (position: number, twin: boolean): string =>
  `og_ep${String(position)}${twin ? '_s' : ''}`;

/**
 * Two templates route the same when they differ only in parameter names (`/{id}` vs `/{wildcard}`) or,
 * because governed APIs route with `ignoreCase` on (G3), only in letter case (`/Admin` vs `/admin`).
 */
export const routingShape = (path: string): string => path.replace(/\{[^}]*\}/g, '{}').toLowerCase();

/**
 * A governed definition the gateway cannot be given safely. The mapper throws it rather than emit an
 * ambiguous or fail-open document; the sync records its message on the row (`FAILED`).
 */
export class EndpointRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointRenderError';
  }
}

/** The first pair of endpoints that would route the same (shape + method), as a message naming both; else null. */
export function routingCollision(refs: readonly EndpointRef[]): string | null {
  const seen = new Map<string, string>();
  for (const ref of refs) {
    const slot = `${ref.method.toUpperCase()} ${routingShape(ref.path)}`;
    const other = seen.get(slot);
    if (other !== undefined) {
      return `Endpoints ${JSON.stringify(other)} and ${JSON.stringify(ref.key)} route the same (${slot}); govern only one of them`;
    }
    seen.set(slot, ref.key);
  }
  return null;
}

/**
 * Why the gateway cannot take `path` as an operation path template, or null. Tyk rejects the whole
 * definition at push for these, so they are refused at write time instead of surfacing as an async FAILED.
 */
export function pathTemplateProblem(path: string): string | null {
  if (!path.startsWith('/')) return 'must start with "/"';
  if (/[:?#]/.test(path)) return 'must not contain ":", "?" or "#"';
  if (path.includes('{{') || path.includes('}}')) return 'must not contain "{{" or "}}"';
  const names: string[] = [];
  let open = false;
  let name = '';
  for (const ch of path) {
    if (ch === '{') {
      if (open) return 'has unbalanced braces';
      open = true;
      name = '';
    } else if (ch === '}') {
      if (!open) return 'has unbalanced braces';
      if (name === '') return 'has an empty parameter "{}"';
      names.push(name);
      open = false;
    } else if (open) {
      name += ch;
    }
  }
  if (open) return 'has unbalanced braces';
  if (new Set(names).size !== names.length) return 'repeats a parameter name';
  return null;
}

/** The trailing-slash twin (G2). `/` has none; a path spelled with a trailing slash gets its bare form. */
function twinPath(path: string): string | null {
  if (path === '/') return null;
  return path.endsWith('/') ? path.slice(0, -1) : `${path}/`;
}

function pathParameters(path: string): Record<string, unknown>[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

/** The Tyk operation fields for one endpoint's stored governance (contract §2). Every field is in `CONTROL_TYK_FIELD`. */
export function endpointOperationFields(
  governance: EndpointGovernance | undefined,
  restrictToSpec: boolean,
  apiWideCache: boolean,
): Record<string, unknown> {
  const g = governance ?? {};
  const fields: Record<string, unknown> = {};
  if (g.enabled === false) fields.block = { enabled: true };
  else if (restrictToSpec) fields.allow = { enabled: true };
  if (g.auth === 'public') fields.ignoreAuthentication = { enabled: true };
  if (g.rateLimit) fields.rateLimit = { enabled: true, rate: g.rateLimit.rate, per: `${String(g.rateLimit.per)}s` };
  // An API-wide cache governs every request; the write path refuses both, and the mapper ignores the endpoint one.
  if (g.cache && !apiWideCache) {
    fields.cache = { enabled: true, timeout: g.cache.timeoutSeconds, cacheResponseCodes: g.cache.cacheResponseCodes ?? [200] };
  }
  if (g.timeoutSeconds !== undefined) fields.enforceTimeout = { enabled: true, value: g.timeoutSeconds };
  if (g.requestSizeLimitBytes !== undefined) fields.requestSizeLimit = { enabled: true, value: g.requestSizeLimitBytes };
  if (g.mock) {
    fields.mockResponse = {
      enabled: true,
      code: g.mock.code,
      body: g.mock.body,
      ...(g.mock.headers ? { headers: g.mock.headers.map((h) => ({ name: h.name, value: h.value })) } : {}),
    };
  }
  if (g.validateRequestSchema) fields.validateRequest = { enabled: true, errorResponseCode: 422 };
  return fields;
}

export interface GovernedOperationsInput {
  /** The whole stored index, in index order (positions name the operations). */
  refs: readonly EndpointRef[];
  endpoints: Readonly<Record<string, EndpointGovernance>>;
  restrictToSpec: boolean;
  /** API-wide per-operation middleware (what the catch-all family hosts). Copied onto every real operation (G5). */
  perOperation: Record<string, unknown>;
  validateRequestSchema?: Record<string, unknown> | null;
  /** The API has `config.cache`. */
  apiWideCache: boolean;
}

export interface GovernedOperationsDocument extends OperationsDocument {
  /** Keys to add to `middleware.global`. Empty when no real operation is emitted. */
  global: Record<string, unknown>;
}

/**
 * Real operations for governed endpoints (every indexed endpoint in allow-list mode), their trailing-slash
 * twins, and the catch-all family merged in around them. Without governance and without allow-list mode
 * this is exactly `buildCatchAllOperations` (contract rule 10).
 */
export function buildGovernedOperations(input: GovernedOperationsInput): GovernedOperationsDocument {
  const { refs, endpoints, restrictToSpec, perOperation, validateRequestSchema, apiWideCache } = input;
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(endpoints, key);
  const methods = new Set<string>(REAL_OPERATION_METHODS);
  const selected = refs
    .map((ref, position) => ({ ref, position, method: ref.method.toUpperCase() }))
    .filter(({ ref, method }) => methods.has(method) && (restrictToSpec || has(ref.key)));

  if (selected.length === 0) {
    // Fail closed: allow-list mode with nothing to carry `allow` would leave every path open.
    if (restrictToSpec) throw new EndpointRenderError('Allow-list mode is on but no endpoint of the specification can be emitted');
    return { ...buildCatchAllOperations(perOperation, validateRequestSchema), global: {} };
  }
  const collision = routingCollision(selected.map(({ ref }) => ref));
  if (collision) throw new EndpointRenderError(collision);

  const paths: Record<string, PathItem> = {};
  const operations: Record<string, unknown> = {};
  const keyOfShape = new Map<string, string>();

  /** Put `operation` at the path item routing like `path`; false when that (shape, method) is taken. */
  const place = (path: string, method: string, operation: Record<string, unknown>): boolean => {
    const shape = routingShape(path);
    let key = keyOfShape.get(shape);
    if (key === undefined) {
      key = path;
      keyOfShape.set(shape, key);
      const parameters = pathParameters(path);
      paths[key] = parameters.length > 0 ? { parameters } : {};
    }
    const item = paths[key];
    const slot = method.toLowerCase();
    if (slot in item) return false;
    item[slot] = operation;
    return true;
  };

  const realOperation = (position: number, method: string, twin: boolean, key: string) => {
    const governance = has(key) ? endpoints[key] : undefined;
    const fields = endpointOperationFields(governance, restrictToSpec, apiWideCache);
    // Endpoint schema wins; otherwise the API-wide one travels with the copied API-wide `validateRequest`.
    const schema = governance?.validateRequestSchema ?? (perOperation.validateRequest ? validateRequestSchema : null);
    const operationId = realOperationId(position, twin);
    return {
      operationId,
      op: {
        operationId,
        responses: { '200': { description: 'ok' } },
        ...(schema ? { requestBody: { required: true, content: { 'application/json': { schema } } } } : {}),
      },
      middleware: { ...perOperation, ...fields },
    };
  };

  // Real paths first (rule 7), then their twins, so a declared path always beats a derived one.
  for (const twin of [false, true]) {
    for (const { ref, position, method } of selected) {
      const path = twin ? twinPath(ref.path) : ref.path;
      if (path === null) continue;
      const { operationId, op, middleware } = realOperation(position, method, twin, ref.key);
      if (place(path, method, op)) operations[operationId] = middleware;
    }
  }

  // Allow-list mode answers 403 for anything undeclared, so the catch-alls would host nothing reachable.
  if (!restrictToSpec) {
    const family = buildCatchAllOperations(perOperation, validateRequestSchema);
    for (const [path, item] of Object.entries(family.paths)) {
      for (const [slot, op] of Object.entries(item)) {
        if (slot === 'parameters') continue;
        const { operationId } = op as { operationId: string };
        if (place(path, slot.toUpperCase(), op as Record<string, unknown>)) operations[operationId] = family.operations[operationId];
      }
    }
  }

  const anyCache = Object.values(operations).some((fields) => isPlainObject(fields) && fields.cache !== undefined);
  return {
    paths,
    operations,
    global: {
      // G3: `/BLOCKED` bypasses a block on `/blocked` unless routing ignores case.
      ignoreCase: { enabled: true },
      ...(anyCache ? { cache: { enabled: true, timeout: 60, cacheAllSafeRequests: false } } : {}),
    },
  };
}

// ── OAS-03: read-back of the managed fields ───────────────────────────────────────────────────────

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A sent value the gateway OMITS on read-back (measured on 5.15.0): an empty `mockResponse.body: ''`, and a
 * `false` such as `middleware.global.cache.cacheAllSafeRequests`. Only these; `0` and everything else stay strict.
 */
const omittedWhenEmpty = (value: unknown): boolean =>
  value === '' || value === false || (Array.isArray(value) && value.length === 0);

/**
 * SUBSET semantics (G10): every key of `desired` is present in `effective` and equal, recursively;
 * extra keys in `effective` (defaults the gateway injects) are ignored. Arrays match element by element.
 * A desired `''`, `[]` or `false` also matches an ABSENT key (the gateway drops them).
 */
export function isSubset(desired: unknown, effective: unknown): boolean {
  if (Array.isArray(desired)) {
    return (
      Array.isArray(effective) &&
      desired.length === effective.length &&
      desired.every((item, i) => isSubset(item, effective[i]))
    );
  }
  if (isPlainObject(desired)) {
    return (
      isPlainObject(effective) &&
      Object.entries(desired).every(([key, value]) =>
        Object.prototype.hasOwnProperty.call(effective, key) ? isSubset(value, effective[key]) : omittedWhenEmpty(value),
      )
    );
  }
  return Object.is(desired, effective);
}

/** Seconds in a Tyk duration (`^(\d+h)?(\d+m)?(\d+s)?$`, not empty), else null. */
export function durationSeconds(value: string): number | null {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match || value === '') return null;
  const [, h, m, sec] = match;
  // Unmatched groups are undefined at runtime (the compiler types them as string).
  const n = (group: string | undefined): number => (group ? Number(group) : 0);
  return n(h) * 3600 + n(m) * 60 + n(sec);
}

/**
 * MEASURED on 5.15.0: the gateway stores `rateLimit.per` canonicalised ("60s" -> "1m", "90s" -> "1m30s",
 * "3600s" -> "1h"). Compare that ONE field as a duration; every other string stays a plain string.
 */
function withCanonicalRatePer(fields: unknown): unknown {
  if (!isPlainObject(fields) || !isPlainObject(fields.rateLimit) || typeof fields.rateLimit.per !== 'string') return fields;
  const seconds = durationSeconds(fields.rateLimit.per);
  return seconds === null ? fields : { ...fields, rateLimit: { ...fields.rateLimit, per: seconds } };
}

/** `x-tyk-api-gateway.middleware.operations` of a Tyk-OAS document, or `{}`. */
export function operationsOf(doc: unknown): Record<string, unknown> {
  const gateway = isPlainObject(doc) ? doc['x-tyk-api-gateway'] : undefined;
  const middleware = isPlainObject(gateway) ? gateway.middleware : undefined;
  return isPlainObject(middleware) && isPlainObject(middleware.operations) ? middleware.operations : {};
}

/** True when the document carries governed (`og_ep*`) operations, i.e. a read-back is owed. */
export const hasRealOperations = (doc: unknown): boolean =>
  Object.keys(operationsOf(doc)).some((id) => id.startsWith('og_ep'));

function globalOf(doc: unknown): Record<string, unknown> {
  const gateway = isPlainObject(doc) ? doc['x-tyk-api-gateway'] : undefined;
  const middleware = isPlainObject(gateway) ? gateway.middleware : undefined;
  return isPlainObject(middleware) && isPlainObject(middleware.global) ? middleware.global : {};
}

/** The global keys a governed definition adds (and so reads back). */
const GOVERNED_GLOBAL_KEYS = ['ignoreCase', 'cache'] as const;

/**
 * What a node does not report as sent, for the parts OAS-03 manages: the middleware of every real
 * (`og_ep*`) operation, the operationId at its `paths[path][method]`, and the governed global keys.
 * `sent` is the pushed document; `effective` is the node's copy (`GET /tyk/apis/oas/:id`). Catch-all
 * operations are not compared: they predate OAS-03 and drift covers the whole document.
 */
export function readBackMismatches(sent: unknown, effective: unknown): string[] {
  const mismatches: string[] = [];
  const effectiveOperations = operationsOf(effective);
  for (const [id, fields] of Object.entries(operationsOf(sent))) {
    if (!id.startsWith('og_ep')) continue;
    const back = Object.prototype.hasOwnProperty.call(effectiveOperations, id) ? effectiveOperations[id] : undefined;
    if (back === undefined || !isSubset(withCanonicalRatePer(fields), withCanonicalRatePer(back))) mismatches.push(id);
  }

  const sentPaths = isPlainObject(sent) && isPlainObject(sent.paths) ? sent.paths : {};
  const effectivePaths = isPlainObject(effective) && isPlainObject(effective.paths) ? effective.paths : {};
  for (const [path, item] of Object.entries(sentPaths)) {
    if (!isPlainObject(item)) continue;
    for (const [method, op] of Object.entries(item)) {
      if (!isPlainObject(op) || typeof op.operationId !== 'string' || !op.operationId.startsWith('og_ep')) continue;
      const backItem = Object.prototype.hasOwnProperty.call(effectivePaths, path) ? effectivePaths[path] : undefined;
      const backOp = isPlainObject(backItem) && Object.prototype.hasOwnProperty.call(backItem, method) ? backItem[method] : undefined;
      if (!isPlainObject(backOp) || backOp.operationId !== op.operationId) mismatches.push(`paths.${path}.${method}`);
    }
  }

  const sentGlobal = globalOf(sent);
  const effectiveGlobal = globalOf(effective);
  if (hasRealOperations(sent)) {
    for (const key of GOVERNED_GLOBAL_KEYS) {
      if (key in sentGlobal && !isSubset(sentGlobal[key], effectiveGlobal[key])) mismatches.push(`middleware.global.${key}`);
    }
  }
  return mismatches;
}
