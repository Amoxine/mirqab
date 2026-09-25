import { createHash } from 'node:crypto';

/**
 * Pure helpers over an uploaded OpenAPI 3.x document (OAS-01). Everything here takes `unknown`: the
 * document is untrusted input that has passed the lint gate, which proves it is well-formed OAS but
 * not that any particular field has the shape a TypeScript interface would claim.
 */

/** Operations an import may index. A document past this is refused, not truncated. */
export const MAX_ENDPOINTS = 5000;

/** Servers considered when the caller picks an upstream. */
export const MAX_SERVERS = 50;

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const MAX_SUMMARY = 200;
const MAX_REF_HOPS = 3;

export interface EndpointRow {
  /** Stable identity across re-imports: the `operationId` when it is present and unique, else `METHOD path`. */
  key: string;
  /** Upper-case HTTP method. */
  method: string;
  path: string;
  operationId: string | null;
  summary: string | null;
  tags: string[];
  deprecated: boolean;
  /** Names of the security schemes the operation requires (operation-level, else document-level). Empty = none declared. */
  securitySchemes: string[];
  /**
   * SHA-256 of the canonical JSON of the raw operation object plus its path item's `parameters`
   * (OAS-04), so a changed parameter, request body, response or security block is visible on
   * re-upload even when every indexed field above is unchanged. A change inside a shared
   * `components` entry the operation `$ref`s is NOT seen. `null` on rows stored before this field existed.
   */
  fingerprint: string | null;
}

export interface ServerOption {
  index: number;
  /** The server URL with `{variables}` replaced by their declared defaults, or null when one has none. */
  url: string | null;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON Pointer (`#/a/b`) into the same document. Anything else, or a broken pointer, is `undefined`. */
function resolveLocalRef(doc: Json, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = doc;
  for (const token of ref.slice(2).split('/')) {
    let decoded = token;
    try {
      decoded = decodeURIComponent(token);
    } catch {
      // A malformed percent-escape is taken literally; the lookup below then simply misses.
    }
    const key = decoded.replace(/~1/g, '/').replace(/~0/g, '~');
    // Own properties only: `constructor`, `__proto__` and friends must never resolve.
    if (!isRecord(node) || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/** A path item may itself be a local `$ref` (OAS 3.1 `components/pathItems`). Followed a few hops, never further. */
function resolvePathItem(doc: Json, item: unknown): Json | undefined {
  let current = item;
  for (let hop = 0; hop <= MAX_REF_HOPS; hop += 1) {
    if (!isRecord(current)) return undefined;
    if (typeof current.$ref !== 'string') return current;
    current = resolveLocalRef(doc, current.$ref);
  }
  return undefined;
}

/**
 * JSON with object keys sorted at every depth, so two documents that differ only in key order or
 * formatting (YAML vs JSON) produce the same text. Written out as a string rather than rebuilt as an
 * object, so a hostile key such as `__proto__` is just text. A YAML alias cycle is cut, not followed.
 */
export function canonicalJson(value: unknown, ancestors = new Set<unknown>()): string {
  if (typeof value !== 'object' || value === null) return value === undefined ? 'null' : JSON.stringify(value);
  if (ancestors.has(value)) return '"[circular]"';
  ancestors.add(value);
  const text = Array.isArray(value)
    ? `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`
    : `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Json)[key], ancestors)}`)
        .join(',')}}`;
  ancestors.delete(value);
  return text;
}

function summaryOf(operation: Json): string | null {
  const summary = typeof operation.summary === 'string' ? operation.summary.trim() : '';
  if (summary) return summary.slice(0, MAX_SUMMARY);
  const description = typeof operation.description === 'string' ? operation.description.trim() : '';
  const firstLine = description.split('\n', 1)[0]?.trim() ?? '';
  return firstLine ? firstLine.slice(0, MAX_SUMMARY) : null;
}

function schemeNames(security: unknown): string[] {
  if (!Array.isArray(security)) return [];
  const names = new Set<string>();
  for (const requirement of security) {
    if (isRecord(requirement)) Object.keys(requirement).forEach((name) => names.add(name));
  }
  return [...names].sort();
}

export interface EndpointIndex {
  endpoints: EndpointRow[];
  /** True when the document holds more than {@link MAX_ENDPOINTS} operations; `endpoints` is then cut at the limit. */
  overflow: boolean;
}

/** One row per path+method, in document order. Never throws on a malformed operation: it is skipped. */
export function buildEndpointIndex(doc: unknown): EndpointIndex {
  if (!isRecord(doc) || !isRecord(doc.paths)) return { endpoints: [], overflow: false };

  const raw: { method: string; path: string; operation: Json; pathParameters: unknown }[] = [];
  let overflow = false;
  outer: for (const [path, item] of Object.entries(doc.paths)) {
    const pathItem = resolvePathItem(doc, item);
    if (!pathItem) continue;
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;
      if (raw.length >= MAX_ENDPOINTS) {
        overflow = true;
        break outer;
      }
      raw.push({ method: method.toUpperCase(), path, operation, pathParameters: pathItem.parameters ?? null });
    }
  }

  // An operationId is only a usable key when it is unique in the document.
  const idCounts = new Map<string, number>();
  for (const { operation } of raw) {
    if (typeof operation.operationId === 'string' && operation.operationId) {
      idCounts.set(operation.operationId, (idCounts.get(operation.operationId) ?? 0) + 1);
    }
  }

  const used = new Set<string>();
  const endpoints = raw.map(({ method, path, operation, pathParameters }): EndpointRow => {
    const operationId =
      typeof operation.operationId === 'string' && operation.operationId ? operation.operationId : null;
    let key = operationId !== null && idCounts.get(operationId) === 1 ? operationId : `${method} ${path}`;
    for (let n = 2; used.has(key); n += 1) key = `${method} ${path} #${String(n)}`;
    used.add(key);

    const security = 'security' in operation ? operation.security : doc.security;
    return {
      key,
      method,
      path,
      operationId,
      summary: summaryOf(operation),
      tags: Array.isArray(operation.tags) ? operation.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      deprecated: operation.deprecated === true,
      securitySchemes: schemeNames(security),
      fingerprint: contentHashOf(canonicalJson({ operation, pathParameters })),
    };
  });

  return { endpoints, overflow };
}

/** `https://{env}.example.com` -> `https://prod.example.com` using the server's declared variable defaults. */
export function expandServerUrl(server: unknown): string | null {
  if (!isRecord(server) || typeof server.url !== 'string') return null;
  const variables = isRecord(server.variables) ? server.variables : {};
  const template = /\{([^}]+)\}/g;

  const defaults = new Map<string, string>();
  for (const [, name] of server.url.matchAll(template)) {
    const variable = Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : undefined;
    if (!isRecord(variable) || typeof variable.default !== 'string') return null;
    defaults.set(name, variable.default);
  }
  return server.url.replace(template, (_match, name: string) => defaults.get(name) ?? '');
}

export function listServers(doc: unknown): ServerOption[] {
  if (!isRecord(doc) || !Array.isArray(doc.servers)) return [];
  return doc.servers.slice(0, MAX_SERVERS).map((server, index) => ({ index, url: expandServerUrl(server) }));
}

/** SHA-256 of the submitted text, so re-uploading the same bytes is recognisable. */
export function contentHashOf(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}
