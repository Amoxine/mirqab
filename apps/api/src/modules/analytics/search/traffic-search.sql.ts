/**
 * The full-text expressions of the search table, written once.
 *
 * `FULLTEXT_ANY` is computed ONCE, by the indexer's INSERT, and stored in the `fts` column the GIN index is built on and
 * the query reads (`FULLTEXT_COLUMN`). It used to be an expression index: the index answered which rows match, but
 * every candidate row was then rechecked by computing `to_tsvector` over its (TOASTed) bodies again. Measured on 120k
 * rows with 2 KB bodies: a phrase in 5% of rows took 7.0 s over 30 days that way and 0.6 s against the stored column;
 * a word in every row 4.0 s against 0.36 s over a day. The stored column costs a third more disk (969 MB -> 1,289 MB
 * there; the GIN index is the same size) and nothing at insert, which computed the vector for the index anyway.
 *
 * `FULLTEXT_REQ` and `FULLTEXT_RES` are only rechecks on the few rows `fts` already matched (a `req:` search must not
 * match a word only the response has), so they are computed per row and indexed by nothing.
 *
 * `'simple'` means no stemming and no stop-word removal: a search for `fund` will not find `funds`,
 * which is what makes the matches predictable (and is why the lean core has no stemmer).
 */

/** The column holding `FULLTEXT_ANY`'s value: one index answers a request-side, response-side or either-side search. */
export const FULLTEXT_COLUMN = 'fts';

/** Both bodies in one document. Used where the value is computed (the insert), never in a query. */
export const FULLTEXT_ANY = `to_tsvector('simple', coalesce(req_body, '') || ' ' || coalesce(res_body, ''))`;
export const FULLTEXT_REQ = `to_tsvector('simple', coalesce(req_body, ''))`;
export const FULLTEXT_RES = `to_tsvector('simple', coalesce(res_body, ''))`;
