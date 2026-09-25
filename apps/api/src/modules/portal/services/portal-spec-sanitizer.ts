import { buildEndpointIndex } from '../../api-import/services/oas-endpoints';

/**
 * Turns an OpenAPI document into what an EXTERNAL developer may read (OAS-06). Pure: no I/O, no
 * clock, never throws on hostile input.
 *
 * The document is tenant-supplied data, and the generated one carries gateway internals. Nothing
 * here trusts either, so the output is a fresh copy built from an allow-by-default walk that drops:
 *
 *  - every `servers` list / object and `server` object at any depth, however malformed (they point at
 *    the upstream, which would let a developer skip the gateway), replaced by ONE entry, the URL
 *    clients really call. The one exception is a schema property that is merely NAMED `servers`;
 *  - every `x-tyk-*` key at any depth (`x-tyk-api-gateway.upstream.url` is the internal `proxyUrl`);
 *  - every `$ref` that is not a local `#…` fragment, so a renderer that resolves references is never
 *    pointed at a URL or a file (this function itself never fetches anything); with it the JSON Schema
 *    keywords that move the base URI a local ref resolves against (`$id`, `$schema` holding an absolute
 *    URL, a non-fragment `$dynamicRef` / `$recursiveRef`, the root `jsonSchemaDialect`);
 *  - `__proto__`, `constructor` and `prototype` keys, the usual prototype-pollution gadget for
 *    whatever merges this JSON later;
 *  - operations that endpoint governance blocks (`enabled: false`), so the docs do not advertise a
 *    route that answers 403, and the `components` target of a hidden path-item `$ref` once nothing else
 *    references it.
 *
 * Text (`description`, `summary`, examples) is passed through untouched: it stays a string, and
 * rendering it as PLAIN TEXT is the web component's job, not something to approximate by escaping here.
 */

/** Values the walk visits before giving up. A 5 MB import is far below this; a bomb is not. */
export const MAX_SANITIZE_NODES = 2_000_000;
/** Nesting the walk follows. Real specifications nest a few dozen levels; 128 leaves room. */
export const MAX_SANITIZE_DEPTH = 128;

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

type Json = Record<string, unknown>;

export interface PortalSpecOptions {
  /** The URL clients call, relative to the gateway origin: `/{tenantSlug}{listenPath}` with no trailing slash. */
  serverUrl: string;
  /** Endpoint keys (`oas-endpoints.ts`) that governance blocks; their operations are not documented. */
  blockedKeys?: ReadonlySet<string>;
}

/** A plain JSON object: from `JSON.parse` or the YAML parser, never a class instance, `Map` or `Date`. */
function isPlainObject(value: unknown): value is Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** A URI with a scheme (`https:`, `file:`) or a network-path reference (`//host/x`). */
const ABSOLUTE_URI = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Whether `key: value` must not reach a developer. `depth` is 1 for the document's own keys;
 * `inPropertyMap` is true for the keys of a schema's `properties` map, where they are property NAMES
 * whose values are schemas (so a property called `servers` or `$id` is data, not a keyword).
 */
function isDropped(key: string, value: unknown, depth: number, inPropertyMap: boolean): boolean {
  if (DANGEROUS_KEYS.has(key) || key.toLowerCase().startsWith('x-tyk-')) return true;
  switch (key) {
    case '$ref':
    case '$dynamicRef':
    case '$recursiveRef':
      return typeof value === 'string' && !value.startsWith('#');
    case '$id':
    case '$schema':
      return typeof value === 'string' && ABSOLUTE_URI.test(value);
    case 'jsonSchemaDialect':
      return depth === 1;
    // At the root ANY `servers` goes (a malformed one included): it is replaced, never merged.
    // Below it, a list or an object of any shape goes, valid or not: a Server Object is not
    // recognisable by its contents (`url`, `variables`, all optional to a hostile author).
    case 'servers':
      return depth === 1 || Array.isArray(value) || (isPlainObject(value) && !inPropertyMap);
    case 'server':
      return isPlainObject(value) && !inPropertyMap;
    default:
      return false;
  }
}

interface Frame {
  source: Json | unknown[];
  target: Json | unknown[];
  depth: number;
  /** `source` is a schema's `properties` map: its keys are property names, not keywords. */
  propertyMap: boolean;
}

/** A value JSON cannot carry (undefined, a function, a Date, a Map, a bigint …). */
const NOT_JSON = Symbol('not-json');
/** The node or depth limit was hit. */
const LIMIT = Symbol('limit');

/**
 * The filtered copy of a plain object, or null when the document is past the node or depth limit.
 * Iterative, so nesting cannot overflow the call stack; every value and key counts, leaves included,
 * so a huge flat array is bounded too.
 */
function copyFiltered(root: Json): Json | null {
  const rootCopy: Json = {};
  const stack: Frame[] = [{ source: root, target: rootCopy, depth: 1, propertyMap: false }];
  let visited = 0;

  /** The copy of one value (its children are queued when it is a container), NOT_JSON, or LIMIT. */
  const take = (value: unknown, depth: number, propertyMap: boolean): unknown => {
    visited += 1;
    const isContainer = Array.isArray(value) || isPlainObject(value);
    if (visited > MAX_SANITIZE_NODES || (isContainer && depth + 1 > MAX_SANITIZE_DEPTH)) return LIMIT;
    if (isContainer) {
      const child: Json | unknown[] = Array.isArray(value) ? [] : {};
      stack.push({ source: value, target: child, depth: depth + 1, propertyMap });
      return child;
    }
    return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? value
      : NOT_JSON;
  };

  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    const { source, target, depth, propertyMap } = frame;
    if (Array.isArray(source)) {
      for (const item of source) {
        const copy = take(item, depth, false);
        if (copy === LIMIT) return null;
        (target as unknown[]).push(copy === NOT_JSON ? null : copy); // a slot JSON cannot carry stays a slot
      }
      continue;
    }
    for (const key of Object.keys(source)) {
      const value = source[key];
      if (isDropped(key, value, depth, propertyMap)) {
        visited += 1;
        if (visited > MAX_SANITIZE_NODES) return null;
        continue;
      }
      // `properties` is a keyword only where the parent is a schema; under a property map it is a property NAME.
      const copy = take(value, depth, key === 'properties' && !propertyMap);
      if (copy === LIMIT) return null;
      // Safe: `__proto__` is always dropped above, so this assignment can never reach the setter.
      if (copy !== NOT_JSON) (target as Json)[key] = copy;
    }
  }
  return rootCopy;
}

/** Path-item `$ref` hops `oas-endpoints.ts` follows when it indexes the document. */
const MAX_REF_HOPS = 3;

/** `#/a/b~1c` -> `['a', 'b/c']`, decoded like `oas-endpoints.ts` does. */
function pointerTokens(ref: string): string[] {
  return ref
    .slice(2)
    .split('/')
    .map((token) => {
      let decoded = token;
      try {
        decoded = decodeURIComponent(token);
      } catch {
        // A malformed percent-escape is taken literally.
      }
      return decoded.replace(/~1/g, '/').replace(/~0/g, '~');
    });
}

/** How many times each string `$ref` value occurs in `root` (iterative; `root` is already bounded). */
function countRefs(root: Json): Map<string, number> {
  const counts = new Map<string, number>();
  const stack: unknown[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (isPlainObject(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') counts.set(value, (counts.get(value) ?? 0) + 1);
        else stack.push(value);
      }
    }
  }
  return counts;
}

/** Removes and returns what the local pointer `ref` points at in `root`; undefined when it points at nothing. */
function takeLocal(root: Json, ref: string): unknown {
  const tokens = pointerTokens(ref);
  const last = tokens.pop();
  let parent: unknown = root;
  for (const token of tokens) {
    if (!isPlainObject(parent) || !Object.prototype.hasOwnProperty.call(parent, token)) return undefined;
    parent = parent[token];
  }
  if (last === undefined || !isPlainObject(parent) || !Object.prototype.hasOwnProperty.call(parent, last)) return undefined;
  const removed = parent[last];
  Reflect.deleteProperty(parent, last);
  return removed;
}

/**
 * A path item was hidden and it was a `$ref` to `ref`: drop that target from `components` as well,
 * unless another `$ref` still points at it, or the target is itself a `$ref` (then the chain is
 * followed). Without this the blocked operation stays published under `components.pathItems`.
 * ponytail: only `#/components/…` targets are ever removed, so a ref into `paths` is left alone.
 */
function dropUnreferencedTargets(copy: Json, ref: string, counts: Map<string, number>): void {
  let current: string | undefined = ref;
  for (let hop = 0; current !== undefined && hop < MAX_REF_HOPS; hop += 1) {
    const remaining = (counts.get(current) ?? 0) - 1; // the reference that just went away
    counts.set(current, remaining);
    if (remaining > 0 || !current.startsWith('#/components/')) return;
    const removed = takeLocal(copy, current);
    current = isPlainObject(removed) && typeof removed.$ref === 'string' ? removed.$ref : undefined;
  }
}

/** Removes the operations `blockedKeys` names from `paths` (already a copy). */
function removeBlocked(copy: Json, original: Json, blockedKeys: ReadonlySet<string>): void {
  const paths = copy.paths;
  if (blockedKeys.size === 0 || !isPlainObject(paths)) return;

  let refCounts: Map<string, number> | undefined;
  for (const row of buildEndpointIndex(original).endpoints) {
    if (!blockedKeys.has(row.key) || !Object.prototype.hasOwnProperty.call(paths, row.path)) continue;
    const item = paths[row.path];
    if (!isPlainObject(item)) continue;

    // ponytail: a path item that is itself a local $ref shares its operations with the target, so it
    // cannot be edited here; the whole item is hidden, siblings included. Inline it if that hurts.
    if (typeof item.$ref === 'string') {
      refCounts ??= countRefs(copy); // counted while this item is still there
      Reflect.deleteProperty(paths, row.path);
      dropUnreferencedTargets(copy, item.$ref, refCounts);
      continue;
    }
    Reflect.deleteProperty(item, row.method.toLowerCase());
    if (!HTTP_METHODS.some((method) => method in item)) Reflect.deleteProperty(paths, row.path);
  }
}

/**
 * The developer-facing copy of `document`, or null when it cannot be served (not an object, or past
 * the work limits) so the caller can fall back to something else instead of publishing a guess.
 */
export function sanitizePortalSpec(document: unknown, options: PortalSpecOptions): Json | null {
  if (!isPlainObject(document)) return null;

  const copy = copyFiltered(document);
  if (copy === null) return null;

  copy.servers = [{ url: options.serverUrl }];
  if (options.blockedKeys) removeBlocked(copy, document, options.blockedKeys);
  return copy;
}

/** Endpoint keys whose governance blocks them: `config.endpoints[key].enabled === false`. */
export function blockedEndpointKeys(config: unknown): Set<string> {
  const blocked = new Set<string>();
  const endpoints = isPlainObject(config) ? config.endpoints : undefined;
  if (!isPlainObject(endpoints)) return blocked;
  for (const [key, governance] of Object.entries(endpoints)) {
    if (isPlainObject(governance) && governance.enabled === false) blocked.add(key);
  }
  return blocked;
}
