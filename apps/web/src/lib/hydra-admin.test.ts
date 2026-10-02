import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_URL, oauthError, sanitizeReturnTo } from './hydra-admin';
import { readOAuthFlowCookie } from './oauth-cookies';

/**
 * Regression suite for the open redirect in `/oauth2/authorize?return_to=` — the value that
 * `/oauth2/callback` navigates the browser to immediately after a real, successful login.
 *
 * The original check was `startsWith('/') && !startsWith('//')`, which every string below defeats:
 * the WHATWG URL parser strips tab/LF/CR from anywhere in the input and reads `\` as `/`, so these
 * look like same-origin paths to a string check and resolve off-origin when anything parses them.
 */
const OFF_ORIGIN = [
  ['backslash', '/\\evil.com'],
  ['double backslash', '/\\\\evil.com'],
  ['mixed slash/backslash', '/\\/evil.com'],
  ['tab (%09 decoded)', '/\t/evil.com'],
  ['line feed (%0A decoded)', '/\n/evil.com'],
  ['carriage return (%0D decoded)', '/\r/evil.com'],
  ['tab inside the host', '//evil\t.com'],
  ['protocol-relative', '//evil.com'],
  ['absolute https', 'https://evil.com'],
  ['absolute http', 'http://evil.com/dashboard'],
  ['leading whitespace', '  https://evil.com'],
  ['javascript scheme', 'javascript:alert(1)'],
  ['data scheme', 'data:text/html,<script>alert(1)</script>'],
  ['userinfo trick', '/\\evil.com/?@localhost:33000'],
] as const;

describe('sanitizeReturnTo', () => {
  it.each(OFF_ORIGIN)('sends %s to /', (_label, raw) => {
    expect(sanitizeReturnTo(raw)).toBe('/');

    // The property that actually matters: whatever comes back, resolving it the way
    // `/oauth2/callback` does must stay on this origin.
    expect(new URL(sanitizeReturnTo(raw), APP_URL).origin).toBe(new URL(APP_URL).origin);
  });

  it.each([null, undefined, ''])('defaults %s to /', (raw) => {
    expect(sanitizeReturnTo(raw)).toBe('/');
  });

  it('keeps a plain path', () => {
    expect(sanitizeReturnTo('/apis')).toBe('/apis');
  });

  it('preserves query and hash', () => {
    expect(sanitizeReturnTo('/analytics?range=7d&tenant=a#chart')).toBe('/analytics?range=7d&tenant=a#chart');
  });

  it('collapses a same-origin double-slash path instead of returning it verbatim', () => {
    // `http://<app-origin>//evil.com` parses as SAME origin (host matches), pathname `//evil.com` —
    // the origin check alone passes it through, and a leading `//` in what gets returned is exactly
    // what makes a LATER `new URL(x, base)` read `x` as protocol-relative. Must not come back as-is.
    const result = sanitizeReturnTo(`${APP_URL}//evil.com`);
    expect(result.startsWith('//')).toBe(false);
    expect(new URL(result, APP_URL).origin).toBe(new URL(APP_URL).origin);
  });

  it('is idempotent for every case above — safe even if a future call site sanitizes only once', () => {
    for (const [, raw] of OFF_ORIGIN) {
      const once = sanitizeReturnTo(raw);
      expect(sanitizeReturnTo(once)).toBe(once);
    }
    expect(sanitizeReturnTo(sanitizeReturnTo(`${APP_URL}//evil.com`))).toBe(sanitizeReturnTo(`${APP_URL}//evil.com`));
  });

  it('accepts an absolute URL on this app origin, reduced to its path', () => {
    expect(sanitizeReturnTo(`${APP_URL}/keys?page=2`)).toBe('/keys?page=2');
  });

  it('keeps an encoded backslash as the literal path it is (same origin, so harmless)', () => {
    // `%5C` is NOT decoded by the parser, so this stays a path segment rather than becoming a host.
    expect(sanitizeReturnTo('/%5Cevil.com')).toBe('/%5Cevil.com');
    expect(new URL(sanitizeReturnTo('/%5Cevil.com'), APP_URL).origin).toBe(new URL(APP_URL).origin);
  });
});

/**
 * Pins the precedence the deployment config depends on. `NEXT_PUBLIC_*` reads are inlined by Next
 * at BUILD time even in server-only modules, so that name cannot be set from a compose
 * `environment:` entry — the unprefixed `APP_URL` is the runtime-settable one, and it has to win.
 */
describe('APP_URL resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const loadAppUrl = async (env: Record<string, string | undefined>) => {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    return (await import('./hydra-admin')).APP_URL;
  };

  it('prefers the runtime APP_URL over the build-time-inlined name', async () => {
    expect(
      await loadAppUrl({ APP_URL: 'https://gw.example.com', NEXT_PUBLIC_APP_URL: 'http://localhost:33000' }),
    ).toBe('https://gw.example.com');
  });

  it.each(['', undefined])('falls back to NEXT_PUBLIC_APP_URL when APP_URL is %o', async (appUrl) => {
    expect(await loadAppUrl({ APP_URL: appUrl, NEXT_PUBLIC_APP_URL: 'https://built-in.example.com' })).toBe(
      'https://built-in.example.com',
    );
  });

  it('falls back to the local default when neither is set', async () => {
    expect(await loadAppUrl({ APP_URL: undefined, NEXT_PUBLIC_APP_URL: undefined })).toBe('http://localhost:33000');
  });

  it('moves the redirect allow-list with the configured origin', async () => {
    vi.resetModules();
    vi.stubEnv('APP_URL', 'https://gw.example.com');
    const mod = await import('./hydra-admin');

    // Same-origin under the NEW origin is kept; the old default is now off-origin and rejected.
    expect(mod.sanitizeReturnTo('https://gw.example.com/apis?page=2')).toBe('/apis?page=2');
    expect(mod.sanitizeReturnTo('http://localhost:33000/apis')).toBe('/');
  });
});

/**
 * A malformed origin used to surface as an opaque `Invalid URL` thrown from `DASHBOARD_REDIRECT_URI`
 * (or `metadataBase`) at import, with no hint which variable to fix. It now fails at the definition,
 * naming the variable that was actually read and the value it held. An EMPTY value is not malformed:
 * it keeps the local default (covered above).
 */
describe('APP_URL validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const load = (env: Record<string, string | undefined>) => {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    return import('./hydra-admin');
  };

  it.each(['example.com', 'localhost:33000', '/just/a/path', 'ftp://files.example.com'])(
    'rejects APP_URL=%s, naming the variable and the value',
    async (value) => {
      await expect(load({ APP_URL: value })).rejects.toThrow(
        `APP_URL must be an absolute http(s) URL such as https://app.example.com, got "${value}"`,
      );
    },
  );

  it('names NEXT_PUBLIC_APP_URL when that is the value in use', async () => {
    await expect(load({ APP_URL: '', NEXT_PUBLIC_APP_URL: 'example.com' })).rejects.toThrow(
      'NEXT_PUBLIC_APP_URL must be an absolute http(s) URL such as https://app.example.com, got "example.com"',
    );
  });

  it('does not fall back to the default for a malformed value', async () => {
    await expect(load({ APP_URL: 'example.com', NEXT_PUBLIC_APP_URL: 'https://ok.example.com' })).rejects.toThrow(
      'APP_URL must be',
    );
  });

  it('accepts a plain https origin and a local http one', async () => {
    expect((await load({ APP_URL: 'https://app.example.com' })).APP_URL).toBe('https://app.example.com');
    expect((await load({ APP_URL: 'http://localhost:33000' })).APP_URL).toBe('http://localhost:33000');
  });
});

describe('readOAuthFlowCookie', () => {
  const flow = (returnTo: string) => JSON.stringify({ state: 's', codeVerifier: 'v', returnTo });

  it('re-sanitises returnTo on read, not just on write', () => {
    expect(readOAuthFlowCookie(flow('/\\evil.com'))?.returnTo).toBe('/');
    expect(readOAuthFlowCookie(flow('https://evil.com'))?.returnTo).toBe('/');
  });

  it('passes a same-origin path through untouched', () => {
    expect(readOAuthFlowCookie(flow('/apis?page=2'))?.returnTo).toBe('/apis?page=2');
  });

  it('rejects a malformed or incomplete cookie', () => {
    expect(readOAuthFlowCookie(undefined)).toBeNull();
    expect(readOAuthFlowCookie('not json')).toBeNull();
    expect(readOAuthFlowCookie(JSON.stringify({ state: 's' }))).toBeNull();
  });
});

describe('oauthError', () => {
  // Regression for /oauth2/callback masking every Hydra rejection (login_reject, an inactive
  // account, an IdentityConflictError) as a generic "invalid_state" — the description is what a
  // user and an operator debugging a report actually need, and it was silently dropped before.
  it('carries the description through to the redirect', () => {
    const res = oauthError('access_denied', 'Could not verify this account. Contact an administrator.');
    const location = res.headers.get('location');
    expect(location).not.toBeNull();
    expect(new URL(location ?? '').searchParams.get('error')).toBe('access_denied');
    expect(new URL(location ?? '').searchParams.get('error_description')).toBe(
      'Could not verify this account. Contact an administrator.',
    );
  });

  it('omits error_description entirely when none is given, not as an empty param', () => {
    const res = oauthError('invalid_state');
    const location = res.headers.get('location');
    expect(location).not.toBeNull();
    expect(new URL(location ?? '').searchParams.has('error_description')).toBe(false);
  });
});
