/**
 * What the audit sheet shows of an entry's recorded `details`, with the platform's internal addressing
 * hidden. Some actions (adopting a gateway's API, a sync) record which gateway node they ran against: a
 * service address on the internal network, and the gateway's own ids. That is useful to the people who
 * run the platform and not something to put in front of a tenant's audit viewer. Only the DISPLAY is
 * changed; the stored entry is not.
 */

/** Shown in place of a hidden value. Not a word, so it needs no translation and reads the same in every language. */
export const MASK = '••••';

/** Keys whose value is always hidden: the node a sync ran against, and any of the gateway's own ids (`tykApiId`, `tykKeyId`…). */
const INTERNAL_KEY = /^(node|nodeUrl|tyk[A-Za-z]*)$/;

const MAX_DEPTH = 32;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;

/** Loopback, link-local and the private ranges (10/8, 172.16/12, 192.168/16), for an IPv4 host. */
function isPrivateIPv4(host: string): boolean {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!parts) return false;
  const [a, b] = [Number(parts[1]), Number(parts[2])];
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** A host that only means something inside the platform's network: a service name, `localhost`, a private address. */
function isInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  // IPv6: unique-local (fc00::/7) and link-local (fe80::/10).
  if (host.includes(':')) return /^(f[cd]|fe[89ab])/.test(host);
  if (isPrivateIPv4(host)) return true;
  // A single label (`tyk-gateway`, `gateway`) is a service name on a container network, never a public host.
  if (!host.includes('.')) return true;
  return /\.(internal|local|lan|svc|cluster\.local|localdomain)$/.test(host);
}

function isInternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isInternalHost(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Credentials inside free text, wherever the key they sit under gives no hint: a `Bearer <token>` (the
 * scheme stays, so it still reads as an Authorization value) and a JWT (three base64url parts, the first
 * two starting `eyJ`, i.e. `{"`). The API redacts these when it writes an entry; this covers what older
 * entries may still hold.
 */
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;

/** `value` with every internal URL (the whole string, or one inside a sentence) and every credential replaced by the mask. */
function maskText(value: string): string {
  if (isInternalUrl(value)) return MASK;
  return value
    .replace(URL_IN_TEXT, (match) => {
      // A sentence ends a URL with punctuation that is not part of it ("…/apis, then…").
      const url = match.replace(/[),.;:!?]+$/, '');
      return isInternalUrl(url) ? `${MASK}${match.slice(url.length)}` : match;
    })
    .replace(BEARER_TOKEN, `$1${MASK}`)
    .replace(JWT, MASK);
}

/** A copy of `value` safe to display: internal keys and internal URLs hidden, everything else as it was. */
export function maskInternalDetails(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return maskText(value);
  if (value === null || typeof value !== 'object') return value;
  // The recorder caps nesting, but an entry is data from outside this file: bound the walk as well.
  if (depth >= MAX_DEPTH) return MASK;
  if (Array.isArray(value)) return value.map((item) => maskInternalDetails(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, INTERNAL_KEY.test(key) ? MASK : maskInternalDetails(item, depth + 1)]),
  );
}
