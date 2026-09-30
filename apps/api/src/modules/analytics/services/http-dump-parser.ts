/**
 * `tyk_analytics.rawrequest` / `rawresponse` (base64 of Go's `httputil.DumpRequest` / `DumpResponse`)
 * turned into something a browser may be shown.
 *
 * Second layer. The insert trigger (`analyticsRedactionDdl`) already blanked a fixed header list and
 * the exact JSON field names it was configured with. It matches exact names only, so `access_token`,
 * `clientSecret` or a header renamed last month walk straight past it. This layer redacts by NAME
 * PATTERN (`isSecretName`) everywhere a secret sits in an HTTP dump: header values, `name=value`
 * pairs (query string, form-encoded body), and JSON fields. It also bounds the body. The caller
 * refuses to show anything at all when the trigger is missing (`TrafficInspectorService`), so the two
 * layers always stack.
 *
 * Known limits, stated rather than hidden: a JSON document embedded as an escaped string inside
 * another (`"payload":"{\"token\":\"x\"}"`) and multipart bodies are not parsed. And the JSON pass
 * pairs quotes left to right, so a stray unbalanced `"` in a NON-JSON body (free text, a malformed
 * payload) shifts it out of step, and a JSON-shaped secret later in that same body can be missed.
 * Valid JSON is unaffected, and the trigger still redacts its exact field names in any body, so the
 * gap is a pattern-only name, after a stray quote, in a body that isn't JSON.
 *
 * Pure (no DB, no network) and never throws: whatever the column holds, the worst case is an odd
 * looking dump, not a failed page. Same parsing shape as `parseResponseDump` in tyk-client.service.ts,
 * but a separate function — that one reads Tyk's `/debug` envelope, this one Pump's columns.
 */

import { TRUNCATED_DUMP_MARKER } from './pump-query.builder';

/** Longest body returned, in characters. Anything past it is cut and `truncated` is set. */
export const MAX_BODY_CHARS = 16 * 1024;

const REDACTED = '[REDACTED]';

/**
 * A header, parameter or JSON key whose value is a secret: contains one of these, case-insensitive,
 * so `newPassword`, `client_secret`, `X-Auth-Token`, `Set-Cookie` and `X-Hub-Signature` all match.
 * `passw`, not `pass`, keeps `passenger` and `compass` readable.
 */
const SECRET_NAME =
  /pass(?:w|phrase|code)|pwd|secret|token|api[-_]?key|private[-_]?key|credential|authorization|signature|session|cookie|credit[-_]?card|card[-_]?number|cvv|cvc/i;
/** Too short to match inside other words (`author`, `className`), so exact names only. */
const SECRET_EXACT = new Set(['pass', 'pin', 'otp', 'sig', 'auth', 'jwt', 'ssn']);
/**
 * A name that ends in a key: `key`, `X-Old-Key`, `signing_key`, `accessKey` — but not `monkey` or
 * `keyword`. Deliberately broad, so it also hides `publicKey`/`sortKey`: an over-redacted field in a
 * debug view costs a click, a leaked key does not.
 */
const KEY_SUFFIX = /(?:^|[-_.])key$/i;
const CAMEL_KEY_SUFFIX = /[a-z0-9]Key$/;

/** `name=value` at the start or after `?`/`&`/`;`. Values stop at whitespace and `"`, so ` HTTP/1.1` and JSON quotes survive. */
const PAIR = /(^|[?&;])([^=&;#\s?"]+)=([^&;#\s"]*)/g;

/**
 * Every JSON string token in ONE pass, each consumed WHOLE (closed, or cut off at the end by the
 * column clip), plus its `: value` when it is a key. Linear by construction: once a `"` starts a
 * match the string part cannot fail, so the scan never restarts at a quote INSIDE a string. A pattern
 * that can restart at any `"`, an escaped `\"` included, took 6-13 s on 48 KB of escaped quotes,
 * blocking the event loop. `\\[\s\S]`, never `\\.`: `.` skips newlines, so `\` + newline would end the
 * token early, fail, and bring the restarts back.
 * Groups: 1 the string, 2 the colon (keys only), 3 the key's string or number value.
 */
const JSON_TOKEN = /"((?:[^"\\]|\\[\s\S])*)(?:"|\\?$)(?:(\s*:\s*)("(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|-?\d[\d.eE+-]*))?/g;
/**
 * What the old trigger left behind (rows stored before worker-3's escape-aware fix): its value matcher
 * `"[^"]*"` stopped at an escaped quote, so `"token":"ab\"TAIL"` was STORED as
 * `"token":"[REDACTED]"TAIL"` (seen on PG16). Anything after a redacted value that is not JSON
 * punctuation is the rest of that secret, up to its real closing quote. Same never-fails tail as
 * `JSON_TOKEN`, so it stays linear too.
 */
const TRIGGER_TAIL = /("\[REDACTED\]")(?![\s,}\]]|$)(?:[^"\\]|\\[\s\S])*(?:"|\\?$)/g;

export interface HttpDump {
  /** Request line (`GET /path?q HTTP/1.1`) or status line (`HTTP/1.1 200 OK`), secrets redacted. */
  startLine: string;
  headers: Record<string, string>;
  body: string;
  /** The body was cut: by the trigger before storage, by the query's clip, or at `MAX_BODY_CHARS`. */
  truncated: boolean;
}

export interface DumpOptions {
  /** The API's configured `authHeaderName`, redacted even when it matches no pattern. */
  authHeaderName?: string | null;
  /** The caller read only a prefix of the column (see `RAW_FETCH_CHARS`). */
  clipped?: boolean;
}

function isSecretName(raw: string): boolean {
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // A malformed escape is still a name; match it as written.
  }
  return (
    SECRET_EXACT.has(name.toLowerCase()) ||
    SECRET_NAME.test(name) ||
    KEY_SUFFIX.test(name) ||
    CAMEL_KEY_SUFFIX.test(name)
  );
}

/**
 * Redacts secret `name=value` pairs: a query string in the request line, a `Referer` or `Location`,
 * a form-encoded body. `code` joins the pattern here only — as a parameter it is an OAuth
 * authorization code, as a JSON key it is almost always an error code.
 */
function redactPairs(text: string): string {
  return text.replace(PAIR, (pair, sep: string, name: string) =>
    isSecretName(name) || name.toLowerCase() === 'code' ? `${sep}${name}=${REDACTED}` : pair,
  );
}

/** Index just past the `{`/`[` at `open`'s matching close, string-aware; the end of the text when a clip cut it open. Linear. */
function containerEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '{' || c === '[') {
      depth++;
    } else if ((c === '}' || c === ']') && --depth === 0) {
      return i + 1;
    }
  }
  return text.length;
}

/** A secret-named key followed by `:` and an opening `{`/`[` (checked without slicing the text). */
const CONTAINER_OPEN = /\s*:\s*[{[]/y;

/**
 * A secret-named key whose value is an object or array (`"cookies":{"sid":"…"}`, `"credentials":[…]`)
 * is redacted WHOLE. `JSON_TOKEN` only knows string and number values, so it left the container alone
 * and judged each inner key on its own name: `sid` matches nothing, and the session id stayed readable.
 * Runs on the same linear token scan; a container is skipped in one pass, never re-scanned.
 */
function redactSecretContainers(text: string): string {
  const tokens = new RegExp(JSON_TOKEN.source, 'g');
  let out = '';
  let last = 0;
  for (let m = tokens.exec(text); m; m = tokens.exec(text)) {
    // A string/number value is `redactJson`'s job; a bare key is the one that may hold a container.
    const [, name = '', colon] = m as (string | undefined)[] as [string, string | undefined, string | undefined];
    if (colon !== undefined || !isSecretName(name)) continue;
    CONTAINER_OPEN.lastIndex = tokens.lastIndex;
    const open = CONTAINER_OPEN.exec(text);
    if (!open) continue;
    const end = containerEnd(text, tokens.lastIndex + open[0].length - 1);
    out += `${text.slice(last, m.index)}"${name}":"${REDACTED}"`;
    last = end;
    tokens.lastIndex = end;
  }
  return out + text.slice(last);
}

/** Redacts secret JSON fields, nested or not, including one whose value the clip cut off. */
function redactJson(text: string): string {
  return redactSecretContainers(text)
    .replace(TRIGGER_TAIL, '$1')
    .replace(JSON_TOKEN, (token, name: string, colon: string | undefined, value: string | undefined) =>
      colon !== undefined && value !== undefined && isSecretName(name) ? `"${name}"${colon}"${REDACTED}"` : token,
    );
}

/** `null` when nothing was captured (empty column). */
export function parseHttpDump(b64: string | null | undefined, options: DumpOptions = {}): HttpDump | null {
  if (typeof b64 !== 'string' || b64 === '') return null;

  // Buffer skips non-base64 characters (including the newlines Postgres's `encode` inserts) and
  // replaces invalid UTF-8 with U+FFFD, so neither step can throw.
  const decoded = Buffer.from(b64, 'base64').toString('utf8');
  // The trigger cut this dump before storing it and said so on a last line of its own. Drop that
  // line (cut inside the headers it would parse as a bogus header) and report it as `truncated`.
  const cut = decoded.endsWith(`\n${TRUNCATED_DUMP_MARKER}`);
  const text = cut ? decoded.slice(0, -(TRUNCATED_DUMP_MARKER.length + 1)) : decoded;
  const blank = /\r?\n\r?\n/.exec(text);
  const head = blank ? text.slice(0, blank.index) : text;
  // Redacted before it is cut, so the cut can never split a secret out of its field.
  const body = redactPairs(redactJson(blank ? text.slice(blank.index + blank[0].length) : ''));
  const [startLine = '', ...lines] = head.split(/\r?\n/);
  const authHeader = options.authHeaderName?.toLowerCase();

  // A Map, not an object: header names come from the client/upstream, and `__proto__` is a legal one.
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim();
    const secret = isSecretName(name) || name.toLowerCase() === authHeader;
    const value = secret ? REDACTED : redactPairs(line.slice(colon + 1).trim());
    const seen = headers.get(name);
    headers.set(name, seen === undefined ? value : `${seen}, ${value}`);
  }

  return {
    startLine: redactPairs(startLine),
    headers: Object.fromEntries(headers),
    body: body.slice(0, MAX_BODY_CHARS),
    truncated: cut || options.clipped === true || body.length > MAX_BODY_CHARS,
  };
}
