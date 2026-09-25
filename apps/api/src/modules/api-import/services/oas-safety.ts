/**
 * Pre-flight checks for an uploaded OpenAPI document (OAS-00).
 *
 * The document is DATA. Two properties of the linting stack make it more than that unless they are
 * refused before the linter sees it:
 *
 *  1. Spectral resolves `$ref` while linting, and `new Spectral()` defaults to a resolver that
 *     follows `http(s)://` and `file:` references. `@stoplight/spectral-ref-resolver` is not a
 *     direct dependency of this package, so a "safe" resolver cannot be passed without adding one;
 *     instead every external reference is found first and the document is rejected, so
 *     `Spectral.run` is never called on it.
 *  2. YAML aliases expand while parsing. A 272-byte document of 7 nested alias levels took ~3.8 s
 *     to parse and the 8th level did not finish in 25 s: one small request can block the event
 *     loop. JSON has no aliases, so a document that parses as JSON is exempt.
 */

/** Aliases a YAML document may use. Real specifications use none or a handful. */
export const MAX_YAML_ALIASES = 5;

/**
 * Size ceiling for a YAML document that uses any alias. Expansion is bounded by roughly
 * `size × (alias combinations)`; with at most {@link MAX_YAML_ALIASES} aliases the combinations
 * stay in the single digits, and 64 KB keeps the worst case well under a second.
 */
export const MAX_ALIAS_DOCUMENT_BYTES = 64 * 1024;

/** Nodes the external-reference walk will visit before giving up (a 5 MB document is far below this). */
const MAX_WALK_NODES = 2_000_000;

/**
 * An anchor or alias NAME: YAML allows any run of non-space characters except the flow indicators
 * `,[]{}` — `é0`, `😈`, `a.b:c` are all valid. (The first version only matched `[A-Za-z0-9_-]`, so a
 * 184-byte document with non-ASCII anchors expanded unchecked.)
 */
const NAME = String.raw`[^\s,[\]{}]+`;

/**
 * An alias, matched by POSITION so prose does not count: at the start of a node, i.e. at the start of
 * a line (a key, a block item, a continuation) or after `:`, `-`, `?`, `,`, `[` or `{` (optionally
 * followed by spaces or tabs, the only YAML separators). An alias cannot carry a tag or an anchor, so
 * no other character can precede one. `*bold*` inside a plain scalar is preceded by a space after a
 * word, so it is not counted.
 */
const YAML_ALIAS = new RegExp(String.raw`(?:^|[:?,[{-])[ \t\uFEFF]*\*${NAME}`, 'gm');

/**
 * An anchor, matched PERMISSIVELY: any `&name` after a line start, whitespace or an indicator. That
 * over-counts `&amp;` in prose, which is harmless — anchors only decide whether aliases can expand at
 * all (without an anchor every alias is a parse error, never an expansion).
 */
const YAML_ANCHOR = new RegExp(String.raw`(?:^|[\s:?,[{-])&${NAME}`, 'gm');

export interface YamlAliasHazard {
  aliases: number;
  /** 1-based line of the first alias token. */
  line: number;
  reason: 'too-many-aliases' | 'document-too-large-for-aliases';
}

/** True when the whole text is a JSON document (which cannot contain YAML aliases). */
export function parsesAsJson(source: string): boolean {
  const first = source.trimStart()[0];
  if (first !== '{' && first !== '[') return false;
  try {
    JSON.parse(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * Null when the document is safe to hand to the YAML parser. Budgets unchanged: at most
 * {@link MAX_YAML_ALIASES} aliases, and none at all past {@link MAX_ALIAS_DOCUMENT_BYTES}.
 */
export function yamlAliasHazard(source: string): YamlAliasHazard | null {
  if (!source.includes('*') || !source.includes('&') || parsesAsJson(source)) return null;
  if (source.search(YAML_ANCHOR) === -1) return null;

  let aliases = 0;
  let firstIndex = -1;
  for (const match of source.matchAll(YAML_ALIAS)) {
    aliases += 1;
    if (firstIndex === -1) firstIndex = match.index;
  }
  if (aliases === 0) return null;

  const line = source.slice(0, firstIndex).split('\n').length;
  if (aliases > MAX_YAML_ALIASES) return { aliases, line, reason: 'too-many-aliases' };
  if (Buffer.byteLength(source, 'utf8') > MAX_ALIAS_DOCUMENT_BYTES) {
    return { aliases, line, reason: 'document-too-large-for-aliases' };
  }
  return null;
}

export interface ExternalRef {
  /** JSON path to the object holding the `$ref`, e.g. `['paths', '/a']`. */
  path: string[];
  ref: string;
}

/**
 * Every `$ref` whose value is not a local fragment (`#…`). Iterative, so a deeply nested document
 * cannot overflow the call stack. Only a STRING value counts: a schema property that happens to be
 * named `$ref` holds an object and is left alone.
 */
export function findExternalRefs(root: unknown): ExternalRef[] {
  const found: ExternalRef[] = [];
  const stack: { value: unknown; path: string[] }[] = [{ value: root, path: [] }];
  let visited = 0;

  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    visited += 1;
    if (visited > MAX_WALK_NODES) break;
    const { value, path } = entry;
    if (value === null || typeof value !== 'object') continue;

    if (Array.isArray(value)) {
      value.forEach((item, index) => stack.push({ value: item, path: [...path, String(index)] }));
      continue;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$ref' && typeof child === 'string' && !child.startsWith('#')) {
        found.push({ path, ref: child });
      } else {
        stack.push({ value: child, path: [...path, key] });
      }
    }
  }
  return found;
}
