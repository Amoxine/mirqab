/**
 * Text that Postgres will accept. A `text` column refuses NUL, and `jsonb` refuses a NUL escape and an
 * unpaired UTF-16 surrogate (what `slice` leaves behind when it cuts an emoji in half, and what
 * `JSON.stringify` then writes as `\ud83d`). One such value in a 500-row `unnest` insert fails the whole
 * statement, so every text that is cut, or that came from a client, goes through here first.
 *
 * `String.prototype.toWellFormed` (Node 22) does the surrogate half, but this project's TypeScript lib
 * stops at ES2022, so the same rule is written out; it is a single linear regex.
 */

/** A high surrogate with no low one after it, or a low one with no high one before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `true` when `text` has no unpaired surrogate. */
export function isWellFormed(text: string): boolean {
  LONE_SURROGATE.lastIndex = 0;
  return !LONE_SURROGATE.test(text);
}

/** `true` when `text` can go into a Postgres text or jsonb value as it is: well formed and no NUL. */
export function isStorable(text: string): boolean {
  return isWellFormed(text) && !text.includes('\u0000');
}

/** `text` made storable: each unpaired surrogate becomes U+FFFD and NUL is dropped. Never throws. */
export function storable(text: string): string {
  return text.replace(LONE_SURROGATE, '�').replaceAll('\u0000', '');
}
