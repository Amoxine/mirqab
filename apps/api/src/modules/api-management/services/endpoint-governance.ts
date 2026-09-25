import { createHash } from 'node:crypto';
import { CONTROL_METHODS } from './endpoint-capabilities';
import { pathTemplateProblem, routingCollision } from './endpoint-operations';

/**
 * Endpoint governance (OAS-03): the pure model behind `PATCH /apis/:id/endpoints`.
 *
 * Stored in `ApiDefinition.config.endpoints` (keyed by the endpoint key of the stored spec index) and
 * `config.restrictToSpec`. It is deliberately NOT part of `ApiConfigDto`, so `PATCH /apis/:id` can never
 * write it past the spec check and the revision. Everything here is deterministic and I/O-free; the
 * service does the reads, the compare-and-set and the sync.
 *
 * Values are stored NORMALISED: a control that means "no change from the API default" (`enabled: true`,
 * `auth: 'inherit'`) is never stored, and an endpoint with nothing left is removed. Two states that behave
 * the same therefore have the same revision.
 */

/** Governed endpoints per API. `restrictToSpec` is refused on an index larger than this too. */
export const MAX_MANAGED_ENDPOINTS = 1000;

/** Largest `validateRequestSchema`, serialised. */
export const MAX_VALIDATE_SCHEMA_BYTES = 65_536;

/**
 * Largest serialised `config.endpoints` (1 MiB). Without it one request fans a 64 KB schema out to 500
 * endpoints (32 MB into the row, the gateway document and every read of the API).
 */
export const MAX_GOVERNANCE_BYTES = 1_048_576;

/** Schema keywords refused in `validateRequestSchema`: they reference or re-root other documents. */
const REFUSED_SCHEMA_KEYWORDS = ['$ref', '$id', '$anchor', '$dynamicRef', '$dynamicAnchor', '$schema'] as const;

export const ENDPOINT_CONTROL_NAMES = [
  'enabled',
  'auth',
  'rateLimit',
  'cache',
  'timeoutSeconds',
  'requestSizeLimitBytes',
  'mock',
  'validateRequestSchema',
] as const;

export type EndpointControlName = (typeof ENDPOINT_CONTROL_NAMES)[number];

export interface EndpointMock {
  code: number;
  body: string;
  headers?: { name: string; value: string }[];
}

export interface EndpointGovernance {
  /** `false` = blocked. `true` is "clear" and never stored. */
  enabled?: false;
  /** `'inherit'` is "clear" and never stored. */
  auth?: 'public';
  /** One counter shared by ALL consumers (measured, G9). `per` in seconds. */
  rateLimit?: { rate: number; per: number };
  /** GET only. */
  cache?: { timeoutSeconds: number; cacheResponseCodes?: number[] };
  timeoutSeconds?: number;
  requestSizeLimitBytes?: number;
  mock?: EndpointMock;
  /** Inline JSON Schema, no `$ref` anywhere. POST/PUT/PATCH only. */
  validateRequestSchema?: Record<string, unknown>;
}

/** What a caller may `set`: like the stored shape, plus the two "clear" spellings. */
export type EndpointGovernanceInput = Omit<EndpointGovernance, 'enabled' | 'auth'> & {
  enabled?: boolean;
  auth?: 'public' | 'inherit';
};

export interface GovernanceState {
  endpoints: Record<string, EndpointGovernance>;
  restrictToSpec: boolean;
}

/** The fields of a stored index row the model needs (structurally an `EndpointRow`). */
export interface IndexedEndpoint {
  key: string;
  method: string;
  path: string;
  tags: readonly string[];
}

export interface EndpointChange {
  keys?: readonly string[];
  tag?: string;
  set?: EndpointGovernanceInput;
  clear?: readonly EndpointControlName[];
  restrictToSpec?: boolean;
  dropOrphans?: boolean;
}

export type ChangeResult = { ok: true; state: GovernanceState } | { ok: false; error: string };

const isDefined = (value: unknown): boolean => value !== undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** At most this many keys are named in an error message. */
const NAMED_MAX = 20;
const nameList = (keys: readonly string[]): string =>
  keys.slice(0, NAMED_MAX).map((key) => JSON.stringify(key)).join(', ') +
  (keys.length > NAMED_MAX ? ` and ${String(keys.length - NAMED_MAX)} more` : '');

/** Drop no-op values; `null` when nothing is left. */
export function normaliseGovernance(input: EndpointGovernanceInput | EndpointGovernance): EndpointGovernance | null {
  const out: EndpointGovernance = {};
  if (input.enabled === false) out.enabled = false;
  if (input.auth === 'public') out.auth = 'public';
  if (input.rateLimit) out.rateLimit = { rate: input.rateLimit.rate, per: input.rateLimit.per };
  if (input.cache) {
    out.cache = {
      timeoutSeconds: input.cache.timeoutSeconds,
      ...(input.cache.cacheResponseCodes && input.cache.cacheResponseCodes.length > 0
        ? { cacheResponseCodes: [...new Set(input.cache.cacheResponseCodes)].sort((a, b) => a - b) }
        : {}),
    };
  }
  if (input.timeoutSeconds !== undefined) out.timeoutSeconds = input.timeoutSeconds;
  if (input.requestSizeLimitBytes !== undefined) out.requestSizeLimitBytes = input.requestSizeLimitBytes;
  if (input.mock) {
    out.mock = {
      code: input.mock.code,
      body: input.mock.body,
      ...(input.mock.headers && input.mock.headers.length > 0
        ? { headers: input.mock.headers.map((h) => ({ name: h.name, value: h.value })) }
        : {}),
    };
  }
  if (input.validateRequestSchema) out.validateRequestSchema = input.validateRequestSchema;
  return Object.keys(out).length > 0 ? out : null;
}

/** Tolerant read of the stored config: anything malformed reads as "not governed". */
export function readGovernanceState(config: { endpoints?: unknown; restrictToSpec?: unknown }): GovernanceState {
  const entries = isRecord(config.endpoints) ? Object.entries(config.endpoints) : [];
  const endpoints = Object.fromEntries(
    entries.flatMap(([key, value]) => {
      const normalised = isRecord(value) ? normaliseGovernance(value as EndpointGovernance) : null;
      return normalised ? [[key, normalised] as const] : [];
    }),
  );
  return { endpoints, restrictToSpec: config.restrictToSpec === true };
}

/** JSON with object keys sorted at every depth, so the revision does not depend on insertion order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

/**
 * The `expectedRevision` a writer must present: sha256 over the normalised governance state and the
 * latest spec version, so `keys`/`dropOrphans` always refer to the index the caller saw — a spec
 * re-upload makes an older revision stale.
 */
export function governanceRevision(state: GovernanceState, specVersion?: number): string {
  return createHash('sha256')
    .update(
      stableStringify({
        endpoints: state.endpoints,
        restrictToSpec: state.restrictToSpec,
        ...(specVersion === undefined ? {} : { specVersion }),
      }),
      'utf8',
    )
    .digest('hex');
}

/** Stored keys that are not in the index: kept, reported, never emitted to the gateway. */
export function orphansOf(
  state: GovernanceState,
  index: readonly IndexedEndpoint[],
): { key: string; governance: EndpointGovernance }[] {
  const known = new Set(index.map((row) => row.key));
  return Object.entries(state.endpoints)
    .filter(([key]) => !known.has(key))
    .map(([key, governance]) => ({ key, governance }));
}

/** Nesting beyond this is refused before anything recursive (JSON.stringify, the gateway) sees the schema. */
export const MAX_VALIDATE_SCHEMA_DEPTH = 64;

/** `null` when acceptable, else why not. The walk is iterative, so a hostile depth cannot overflow the stack. */
export function validateSchemaProblem(schema: Record<string, unknown>): string | null {
  const stack: { node: unknown; depth: number }[] = [{ node: schema, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (typeof node !== 'object' || node === null) continue;
    if (depth > MAX_VALIDATE_SCHEMA_DEPTH) {
      return `validateRequestSchema is nested deeper than ${String(MAX_VALIDATE_SCHEMA_DEPTH)} levels`;
    }
    if (!Array.isArray(node)) {
      // The gateway rejects an external `$ref`; a local one, `$id`/`$anchor` re-rooting or `$schema` would
      // point into a document it does not have (the generated definition): the schema must be self-contained.
      const keyword = REFUSED_SCHEMA_KEYWORDS.find((k) => Object.prototype.hasOwnProperty.call(node, k));
      if (keyword) return `validateRequestSchema must not contain "${keyword}"`;
      // OAS 3.0 (the generated document's version) has no type arrays; the push would fail.
      if (Array.isArray((node as Record<string, unknown>).type)) return 'validateRequestSchema must not give "type" as an array';
    }
    for (const child of Object.values(node)) stack.push({ node: child, depth: depth + 1 });
  }
  if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > MAX_VALIDATE_SCHEMA_BYTES) {
    return `validateRequestSchema is larger than ${String(MAX_VALIDATE_SCHEMA_BYTES)} bytes`;
  }
  return null;
}

/**
 * Apply one PATCH to a state. Pure: returns the new normalised state, or the reason it is refused (400).
 * `apiWideCache`: the API has `config.cache`, which conflicts with per-endpoint cache.
 */
export function applyEndpointChange(
  state: GovernanceState,
  index: readonly IndexedEndpoint[],
  change: EndpointChange,
  apiWideCache: boolean,
): ChangeResult {
  const { keys, tag, set, clear, restrictToSpec, dropOrphans } = change;
  const edits = set !== undefined || (clear !== undefined && clear.length > 0);

  if (!edits && (keys !== undefined || tag !== undefined)) {
    return { ok: false, error: 'keys/tag select endpoints for set/clear; give set or clear' };
  }
  if (!edits && restrictToSpec === undefined && dropOrphans !== true) {
    return { ok: false, error: 'Nothing to change: give set, clear, restrictToSpec or dropOrphans' };
  }
  if (edits && (keys === undefined) === (tag === undefined)) {
    return { ok: false, error: 'Give exactly one of keys or tag with set/clear' };
  }

  const byKey = new Map(index.map((row) => [row.key, row]));
  let targets: IndexedEndpoint[] = [];
  if (keys !== undefined) {
    const unknown = [...new Set(keys)].filter((key) => !byKey.has(key));
    if (unknown.length > 0) return { ok: false, error: `Unknown endpoint key(s): ${nameList(unknown)}` };
    targets = [...new Set(keys)].flatMap((key) => {
      const row = byKey.get(key);
      return row ? [row] : [];
    });
  } else if (tag !== undefined) {
    targets = index.filter((row) => row.tags.includes(tag));
    if (targets.length === 0) return { ok: false, error: `No endpoint carries the tag ${JSON.stringify(tag)}` };
  }

  if (set !== undefined && clear !== undefined) {
    const both = clear.filter((control) => set[control] !== undefined);
    if (both.length > 0) return { ok: false, error: `Both set and cleared: ${both.join(', ')}` };
  }
  if (set?.cache && apiWideCache) {
    return { ok: false, error: 'Per-endpoint cache is refused while the API has an API-wide cache (config.cache)' };
  }
  if (set?.validateRequestSchema) {
    const problem = validateSchemaProblem(set.validateRequestSchema);
    if (problem) return { ok: false, error: problem };
  }
  for (const [control, methods] of Object.entries(CONTROL_METHODS)) {
    if (set?.[control as keyof EndpointGovernanceInput] === undefined) continue;
    const wrong = targets.filter((row) => !methods.includes(row.method.toUpperCase())).map((row) => row.key);
    if (wrong.length > 0) {
      return { ok: false, error: `${control} applies to ${methods.join('/')} only; not to ${nameList(wrong)}` };
    }
  }

  const endpoints = new Map(Object.entries(state.endpoints));
  for (const { key } of targets) {
    const cleared = new Set<string>(clear ?? []);
    // `set` values skip `undefined`: a DTO instance carries its absent fields as own undefined properties.
    const next = Object.fromEntries([
      ...Object.entries(endpoints.get(key) ?? {}).filter(([control]) => !cleared.has(control)),
      ...Object.entries(set ?? {}).filter(([, value]) => isDefined(value)),
    ]) as EndpointGovernanceInput;
    const normalised = normaliseGovernance(next);
    if (normalised) endpoints.set(key, normalised);
    else endpoints.delete(key);
  }
  if (dropOrphans === true) {
    for (const key of [...endpoints.keys()]) if (!byKey.has(key)) endpoints.delete(key);
  }
  if (endpoints.size > MAX_MANAGED_ENDPOINTS) {
    return { ok: false, error: `At most ${String(MAX_MANAGED_ENDPOINTS)} endpoints can be governed per API` };
  }
  let bytes = 0;
  for (const [key, governance] of endpoints) {
    bytes += Buffer.byteLength(JSON.stringify(key) + JSON.stringify(governance), 'utf8');
    if (bytes > MAX_GOVERNANCE_BYTES) {
      return { ok: false, error: `Endpoint governance is limited to ${String(MAX_GOVERNANCE_BYTES)} bytes per API` };
    }
  }

  const restrict = restrictToSpec ?? state.restrictToSpec;
  if (restrictToSpec === true && !state.restrictToSpec) {
    if (index.length === 0) return { ok: false, error: 'Allow-list mode needs a stored specification with endpoints' };
    if (index.length > MAX_MANAGED_ENDPOINTS) {
      return {
        ok: false,
        error: `Allow-list mode is limited to specifications of at most ${String(MAX_MANAGED_ENDPOINTS)} endpoints`,
      };
    }
  }

  // What the mapper will emit: refuse here what the gateway would reject (or route ambiguously) at push.
  const selected = restrict ? [...index] : index.filter((row) => endpoints.has(row.key));
  for (const row of selected) {
    const problem = pathTemplateProblem(row.path);
    if (problem) return { ok: false, error: `Endpoint ${JSON.stringify(row.key)} cannot be governed: its path ${JSON.stringify(row.path)} ${problem}` };
  }
  const collision = routingCollision(selected);
  if (collision) return { ok: false, error: collision };

  // `Object.fromEntries` defines own properties, so a key such as "__proto__" stays data.
  return { ok: true, state: { endpoints: Object.fromEntries(endpoints), restrictToSpec: restrict } };
}

/** The config keys to write back: `restrictToSpec` false and an empty map are removed, not stored. */
export function governanceConfigPatch(state: GovernanceState): {
  endpoints?: Record<string, EndpointGovernance>;
  restrictToSpec?: true;
} {
  return {
    ...(Object.keys(state.endpoints).length > 0 ? { endpoints: state.endpoints } : {}),
    ...(state.restrictToSpec ? { restrictToSpec: true as const } : {}),
  };
}
