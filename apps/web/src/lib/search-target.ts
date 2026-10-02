/**
 * The request a search page URL points at (`?req=<id>&ts=<ts>`): the shareable deep link to one
 * captured request. The detail endpoint needs both, because the id is only unique within one day's
 * partition, and `ts` is what lets it open that one.
 */
export interface SearchTarget {
  id: string;
  ts: string;
}

/** A bigint as text: the request id, and the only shape that may go into the detail URL's path. */
const ID = /^\d{1,19}$/;
/** The timestamp the API itself writes (`…T…Z`, microseconds optional), which is what its detail route reads back. */
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/**
 * The target a URL names, or null when it names none or names something malformed. The id goes into
 * an API path, so a link that carries anything but digits is ignored rather than requested.
 */
export function parseSearchTarget(params: URLSearchParams): SearchTarget | null {
  const id = params.get('req');
  const ts = params.get('ts');
  return id !== null && ts !== null && ID.test(id) && TS.test(ts) ? { id, ts } : null;
}

/** A copy of `params` pointing at `target` (or at none, for null); the search and range in it are kept. */
export function withSearchTarget(params: URLSearchParams, target: SearchTarget | null): URLSearchParams {
  const next = new URLSearchParams(params);
  if (target) {
    next.set('req', target.id);
    next.set('ts', target.ts);
  } else {
    next.delete('req');
    next.delete('ts');
  }
  return next;
}

/**
 * The key a request's row control carries (`data-focus-return`) and its sheet looks up on closing, so
 * focus goes back to that row. A list item has the same two fields as a target.
 */
export const searchRequestKey = (target: SearchTarget): string => `search:${target.id}@${target.ts}`;
