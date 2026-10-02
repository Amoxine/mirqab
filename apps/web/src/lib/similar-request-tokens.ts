import { searchToken } from '@/lib/traffic-filters-to-query';
import { SEARCH_LIMITS } from '@/lib/traffic-search';

export type SimilarKind = 'path' | 'status' | 'api' | 'key';

export interface SimilarAction {
  kind: SimilarKind;
  /** The filter this adds to the search; null when this request has no such value or the bar cannot write it. */
  token: string | null;
  /** Why the action is off: no usable value, the filter is already there, or the search is at its clause cap. */
  blocked: 'unsupported' | 'present' | 'full' | null;
}

/** The fields of a search result that "find similar" reads (a list item and an opened request both have them). */
export interface SimilarSource {
  path: string;
  status: number;
  apiId: string | null;
  keyAlias: string;
}

/**
 * The "find similar" actions for one request, as search filters. A token comes from `searchToken`,
 * so it is one the bar accepts (quoted when it has a space, refused when it cannot be written);
 * `currentTokens` is the search as it stands, which decides what is a duplicate and whether there is
 * room under the clause cap.
 */
export function similarActions(source: SimilarSource, currentTokens: readonly string[]): SimilarAction[] {
  const candidates: [SimilarKind, string | null][] = [
    ['path', searchToken('path', source.path)],
    ['status', searchToken('status', String(source.status))],
    ['api', source.apiId ? searchToken('api', source.apiId) : null],
    ['key', source.keyAlias ? searchToken('key', source.keyAlias) : null],
  ];
  const full = currentTokens.length >= SEARCH_LIMITS.maxClauses;
  return candidates.map(([kind, token]) => ({
    kind,
    token,
    blocked:
      token === null ? 'unsupported' : currentTokens.includes(token) ? 'present' : full ? 'full' : null,
  }));
}
