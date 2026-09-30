/**
 * The full-text expression the search table's GIN index is built on, written once. Postgres only
 * uses an expression index when the query repeats the exact expression, so both the DDL and the
 * query builder import these strings; a test asserts the builder emits them verbatim.
 *
 * `'simple'` means no stemming and no stop-word removal: a search for `fund` will not find `funds`,
 * which is what makes the matches predictable (and is why the lean core has no stemmer).
 */

/** Both bodies in one document: one index answers a request-side, response-side or either-side search. */
export const FULLTEXT_ANY = `to_tsvector('simple', coalesce(req_body, '') || ' ' || coalesce(res_body, ''))`;
export const FULLTEXT_REQ = `to_tsvector('simple', coalesce(req_body, ''))`;
export const FULLTEXT_RES = `to_tsvector('simple', coalesce(res_body, ''))`;
