import type { EndpointRow } from './oas-endpoints';

/**
 * Pure diff of two endpoint indexes (OAS-04). Identity is the endpoint KEY, nothing else: a renamed
 * `operationId` changes the key, so it is one removal plus one addition — never a "change" that would
 * silently carry the old key's governance over to a different operation.
 */

/** The fields a `changed` entry can name, in this order. */
export const DIFF_FIELDS = ['method', 'path', 'summary', 'tags', 'deprecated', 'securitySchemes', 'fingerprint'] as const;
export type DiffField = (typeof DIFF_FIELDS)[number];

export interface EndpointChange {
  key: string;
  before: EndpointRow;
  after: EndpointRow;
  fields: DiffField[];
}

export interface SpecDiff {
  added: EndpointRow[];
  removed: EndpointRow[];
  changed: EndpointChange[];
}

export interface GovernanceImpact<G> {
  /** Governed endpoints the new document no longer declares: their governance becomes orphaned. */
  removedGoverned: { key: string; governance: G }[];
  /** Keys of governed endpoints the new document changes. Their governance is kept as is. */
  changedGoverned: string[];
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function changedFields(before: EndpointRow, after: EndpointRow): DiffField[] {
  const fields: DiffField[] = [];
  if (before.method !== after.method) fields.push('method');
  if (before.path !== after.path) fields.push('path');
  if (before.summary !== after.summary) fields.push('summary');
  if (!sameList(before.tags, after.tags)) fields.push('tags');
  if (before.deprecated !== after.deprecated) fields.push('deprecated');
  if (!sameList(before.securitySchemes, after.securitySchemes)) fields.push('securitySchemes');
  // Rows stored before OAS-04 have no fingerprint (absent, not just null): compare index fields only.
  const was = before.fingerprint ?? null;
  const now = after.fingerprint ?? null;
  if (was !== null && now !== null && was !== now) fields.push('fingerprint');
  return fields;
}

/** `added` in the new document's order, `removed` in the old one's, `changed` in the new one's. */
export function diffEndpoints(before: readonly EndpointRow[], after: readonly EndpointRow[]): SpecDiff {
  // Maps, not objects: keys come from the uploaded document (`__proto__`, `constructor`, …).
  const old = new Map(before.map((row) => [row.key, row]));
  const next = new Map(after.map((row) => [row.key, row]));

  const added: EndpointRow[] = [];
  const changed: EndpointChange[] = [];
  for (const row of after) {
    const previous = old.get(row.key);
    if (previous === undefined) {
      added.push(row);
      continue;
    }
    const fields = changedFields(previous, row);
    if (fields.length > 0) changed.push({ key: row.key, before: previous, after: row, fields });
  }
  const removed = before.filter((row) => !next.has(row.key));
  return { added, removed, changed };
}

/**
 * Which of the stored governance entries the diff touches. `governance` is `config.endpoints` as
 * stored; only its OWN keys count, so an endpoint keyed `constructor` is not "governed" by
 * `Object.prototype.constructor`.
 */
export function governanceImpact<G>(diff: SpecDiff, governance: Readonly<Record<string, G>>): GovernanceImpact<G> {
  const governed = (key: string): boolean => Object.prototype.hasOwnProperty.call(governance, key);
  return {
    removedGoverned: diff.removed
      .filter((row) => governed(row.key))
      .map((row) => ({ key: row.key, governance: governance[row.key] })),
    changedGoverned: diff.changed.filter((change) => governed(change.key)).map((change) => change.key),
  };
}
