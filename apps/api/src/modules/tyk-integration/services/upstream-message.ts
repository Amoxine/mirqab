/**
 * The gateway's own error text is forwarded to API clients (and from there to the dashboard's toasts
 * and sync status) so a validation hint stays useful. It can also name the infrastructure or an
 * internal address (`Tyk Pump: redis timeout at http://tyk-gateway:8081/...`), which a customer must
 * not read. This swaps the names for neutral words and addresses for "an internal address", and
 * leaves the rest of the sentence alone. The original is logged by the caller, never forwarded.
 */

const INTERNAL_ADDRESS = 'an internal address';

// Addresses first, so the host names inside them are gone before the name rules run.
const ADDRESSES: RegExp[] = [
  // scheme://anything: http(s), redis://, postgresql://, tyk://
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi,
  // host:port, for a dotted or hyphenated host or a known service name: tyk-gateway:8081, redis:6379
  /(?<![\w.-])(?:(?:[a-z0-9-]+\.)+[a-z0-9-]+|[a-z0-9]+(?:-[a-z0-9-]+)+|redis|postgres|hydra|kratos|keto|tyk|localhost):\d{2,5}(?!\w)/gi,
  // 10.0.0.7 or 10.0.0.7:8080
  /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?(?![\w.])/g,
];

/** A whole word: `_` and digits do not join words here, so `tyk_analytics` and `Redis7` still match. */
const word = (alternatives: string): RegExp => new RegExp(`(?<![A-Za-z0-9])(?:${alternatives})s?(?![A-Za-z0-9])`, 'gi');

// Phrases before the single names they contain, so "Tyk Pump" is one collector, not "gateway collector".
const NAMES: [RegExp, string][] = [
  [word('tyk[\\s_-]?pump'), 'analytics collector'],
  [word('tyk[\\s_-]?gateway'), 'gateway'],
  [word('tyk'), 'gateway'],
  [word('pump'), 'analytics collector'],
  [word('redis|postgres(?:ql)?|prisma'), 'data store'],
  [word('hydra|kratos|keto|ory'), 'identity service'],
  [word('oas'), 'OpenAPI'],
];

const atSentenceStart = (text: string, offset: number): boolean => offset === 0 || /[.!?]\s+$/.test(text.slice(0, offset));

export function neutraliseUpstreamMessage(message: string): string {
  let text = ADDRESSES.reduce((current, pattern) => current.replace(pattern, INTERNAL_ADDRESS), message);
  for (const [pattern, replacement] of NAMES) {
    text = text.replace(pattern, (_match: string, offset: number, whole: string) =>
      atSentenceStart(whole, offset) ? `${replacement.charAt(0).toUpperCase()}${replacement.slice(1)}` : replacement,
    );
  }
  // "Tyk Gateway gateway" would otherwise read "gateway gateway".
  return text.replace(/\b(gateway|data store|identity service)(\s+\1\b)+/gi, '$1');
}
