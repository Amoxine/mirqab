/**
 * What `no-tech-terms.test.ts` scans with. Nothing a browser user can read may name the infrastructure
 * behind the product; OpenAPI, JWT and OAuth stay, they are standards customers work with.
 */

const BANNED_WORDS = [
  'tyk', 'pump', 'redis', 'hydra', 'kratos', 'keto', 'ory', 'postgres', 'postgresql', 'postgre', 'prisma', 'nest', 'nestjs',
  'oas',
];

/** Words that may sit beside a banned one in a run-together name: `tykgateway`, `redispump`. */
const GLUE_WORDS = ['gateway', 'server', 'service', 'host', 'admin', 'node', 'proxy', 'api', 'cache', 'store', 'cluster', 'db', 'sql'];

/** Each stem with its plural; the flag says whether it is a banned word or only glue. */
const STEMS: [stem: string, banned: boolean][] = [
  ...BANNED_WORDS.flatMap((word): [string, boolean][] => [[word, true], [`${word}s`, true]]),
  ...GLUE_WORDS.flatMap((word): [string, boolean][] => [[word, false], [`${word}s`, false]]),
];

/**
 * True when `word` is made of nothing but banned and glue stems with at least one banned stem. The
 * whole word has to be covered, so `redistribute`, `hydrate`, `nested`, `ketone`, `oasis`, `pumpkin`
 * and `story` are never mistaken for one.
 */
function isBannedWord(word: string): boolean {
  // After i letters: `glueOnly[i]` = they split into stems with no banned one yet, `withBanned[i]` = with one.
  const glueOnly = new Array<boolean>(word.length + 1).fill(false);
  const withBanned = new Array<boolean>(word.length + 1).fill(false);
  glueOnly[0] = true;
  for (let i = 0; i < word.length; i += 1) {
    if (!glueOnly[i] && !withBanned[i]) continue;
    for (const [stem, banned] of STEMS) {
      if (!word.startsWith(stem, i)) continue;
      const end = i + stem.length;
      if (banned) withBanned[end] = true;
      else {
        glueOnly[end] ||= glueOnly[i] === true;
        withBanned[end] ||= withBanned[i] === true;
      }
    }
  }
  return withBanned[word.length] === true;
}

/**
 * Splits on anything that is not a letter or digit, then on camelCase and letter/digit boundaries, so
 * `tyk_gateway`, `TykGateway`, `Redis7` and `PostgreSQL` each expose the banned word they contain.
 */
const WORD_BREAK =
  /[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/;

/** The first banned word in `text` (plurals and run-together names included), or undefined. */
export function findBanned(text: string): string | undefined {
  return text.split(WORD_BREAK).find((word) => isBannedWord(word.toLowerCase()));
}

/** Stands in for a `${...}` interpolation: not whitespace, not a letter, so it neither makes a literal look like prose nor joins words. */
const INTERPOLATION = '…';

export interface Literal {
  /** The literal's text with each `${...}` interpolation replaced by `…`: only what is typed in the source is scanned. */
  text: string;
  /** The callee of every call the literal sits inside, outermost first: `@ApiOperation`, `this.logger.warn`, `new Error`. */
  callers: string[];
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r' };

function readLiteral(source: string, start: number): { text: string; end: number } {
  const quote = source[start];
  let text = '';
  let i = start + 1;
  while (i < source.length && source[i] !== quote) {
    if (source[i] === '\\') {
      const escaped = source[i + 1] ?? '';
      text += ESCAPES[escaped] ?? escaped;
      i += 2;
    } else if (quote === '`' && source.startsWith('${', i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') depth -= 1;
        i += 1;
      }
      text += INTERPOLATION;
    } else {
      text += source.charAt(i);
      i += 1;
    }
  }
  if (i >= source.length) throw new Error(`unterminated string literal: ${source.slice(start, start + 40)}`);
  return { text, end: i };
}

/** Characters after which a `/` opens a regular expression rather than dividing. */
const BEFORE_REGEX = '(,=:[!&|?{};+-*%<>~^';
const REGEX_KEYWORD = /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do)\s*$/;

/** Index just past the regular expression literal that starts at `start` (flags included). */
function skipRegex(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length && source[i] !== '\n') {
    const ch = source[i];
    if (ch === '\\') i += 2;
    else if (ch === '[') {
      inClass = true;
      i += 1;
    } else if (ch === ']') {
      inClass = false;
      i += 1;
    } else if (ch === '/' && !inClass) {
      i += 1;
      break;
    } else i += 1;
  }
  while (/[a-z]/.test(source[i] ?? '')) i += 1;
  return i;
}

/** `this.logger.warn`, `@ApiProperty`, `new Error`... the name right before the `(` at `index`. */
function calleeBefore(source: string, index: number): string {
  const match = /(new\s+)?(@?[\w$]+(?:\??\.[\w$]+|\[[\w$.]+\])*)\s*$/.exec(source.slice(Math.max(0, index - 120), index));
  return match ? `${match[1] ? 'new ' : ''}${match[2] ?? ''}` : '';
}

/**
 * Every string literal of a TypeScript file that holds prose (contains whitespace), with the calls it
 * is nested in. Comments and regular expression literals are skipped. A literal with no whitespace is
 * an identifier, not prose: a module path, property key, header or env var name, URL path, or machine
 * code such as `OAS_LINT_FAILED` (those codes are the API contract and stay).
 *
 * This is a reader, not a parser: it throws when it loses its place (an unterminated literal, a `)`
 * with no `(`, a `(` never closed), so a construct it misreads fails loudly instead of silently
 * hiding or inventing literals.
 */
export function proseLiterals(source: string): Literal[] {
  const found: Literal[] = [];
  const calls: string[] = [];
  let lastSignificant = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? '';
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const newline = source.indexOf('\n', i);
      i = newline === -1 ? source.length : newline;
    } else if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 2;
    } else if (
      ch === '/' &&
      (lastSignificant === '' ||
        BEFORE_REGEX.includes(lastSignificant) ||
        REGEX_KEYWORD.test(source.slice(Math.max(0, i - 12), i)))
    ) {
      i = skipRegex(source, i);
      lastSignificant = ')';
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const { text, end } = readLiteral(source, i);
      if (/\s/.test(text)) found.push({ text, callers: [...calls] });
      i = end + 1;
      lastSignificant = ch;
    } else {
      if (ch === '(') calls.push(calleeBefore(source, i));
      else if (ch === ')' && calls.pop() === undefined) throw new Error(`unbalanced ")" near: ${source.slice(Math.max(0, i - 40), i + 1)}`);
      if (!/\s/.test(ch)) lastSignificant = ch;
      i += 1;
    }
  }
  if (calls.length > 0) {
    throw new Error(`${String(calls.length)} "(" never closed, the innermost after: ${calls.at(-1) ?? ''}`);
  }
  return found;
}

/**
 * The only places API prose is allowed to name the infrastructure, because it never reaches a
 * browser. Anything else (exception messages, returned `error`/`message` fields, DTO validation
 * messages, helper arguments, health summaries...) is scanned.
 */
export const ALLOWED_CONTEXTS: { reason: string; callee?: RegExp; text?: RegExp }[] = [
  { reason: 'server logs', callee: /(^|\.)(logger|console)(\.\w+|\[\w+\])$|^new Logger$|^log$/ },
  { reason: 'Swagger / OpenAPI decorator text, not the product UI', callee: /^@Api\w*$/ },
  { reason: 'a plain Error becomes a generic 500 (AllExceptionsFilter); its text is never forwarded', callee: /^new Error$/ },
  { reason: 'Prometheus HELP text, scraped by ops', callee: /^new (Counter|Gauge|Histogram|Summary)$/ },
  { reason: 'SQL run against the database, never sent anywhere', text: /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|DO)\b/ },
];

/** The reasons of every `ALLOWED_CONTEXTS` entry the literal sits inside of, or is. */
export function allowedReasons(literal: Literal): string[] {
  return ALLOWED_CONTEXTS.filter(
    (allowed) =>
      allowed.text?.test(literal.text) === true ||
      (allowed.callee !== undefined && literal.callers.some((callee) => allowed.callee?.test(callee))),
  ).map((allowed) => allowed.reason);
}

/** True unless the literal is in an allowed context. */
export function reachesBrowser(literal: Literal): boolean {
  return allowedReasons(literal).length === 0;
}
