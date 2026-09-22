import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizeClientReturnTo, sanitizeToOrigin } from './return-to';

const ORIGIN = 'http://localhost:33000';

describe('sanitizeToOrigin', () => {
  it('defaults nullish/empty to /', () => {
    expect(sanitizeToOrigin(null, ORIGIN)).toBe('/');
    expect(sanitizeToOrigin(undefined, ORIGIN)).toBe('/');
    expect(sanitizeToOrigin('', ORIGIN)).toBe('/');
  });

  it('keeps a same-origin path, query and hash', () => {
    expect(sanitizeToOrigin('/apis?page=2#top', ORIGIN)).toBe('/apis?page=2#top');
  });

  it('reduces an absolute same-origin URL to its path', () => {
    expect(sanitizeToOrigin(`${ORIGIN}/keys`, ORIGIN)).toBe('/keys');
  });

  it('rejects a different origin', () => {
    expect(sanitizeToOrigin('https://evil.com/dashboard', ORIGIN)).toBe('/');
  });

  it('collapses a same-origin double-slash path (would otherwise read as protocol-relative)', () => {
    expect(sanitizeToOrigin(`${ORIGIN}//evil.com`, ORIGIN)).toBe('/evil.com');
  });

  it('is idempotent', () => {
    for (const raw of ['https://evil.com', `${ORIGIN}//evil.com`, '/apis', null]) {
      const once = sanitizeToOrigin(raw, ORIGIN);
      expect(sanitizeToOrigin(once, ORIGIN)).toBe(once);
    }
  });

  it('rejects a malformed origin by failing safe, not throwing', () => {
    expect(sanitizeToOrigin('/apis', 'not-a-url')).toBe('/');
  });

  /**
   * The exact bypass this function exists for: Kratos checks `return_to` against
   * `allowed_return_urls` with Go's `net/url`, which reads this as scheme `http`, empty host — same
   * origin as far as that check is concerned. The WHATWG parser (Node's `URL`, and every browser)
   * reads the SAME string as origin `http://evil.com`. A check using the WHATWG parser must reject
   * it, because that's the parser `window.location.href = ...` actually resolves with.
   */
  it('rejects the WHATWG-vs-Go net/url parser differential (http:/\\/\\evil.com)', () => {
    expect(sanitizeToOrigin('http:/\\/\\evil.com', ORIGIN)).toBe('/');
    expect(sanitizeToOrigin('/\\/\\evil.com', ORIGIN)).toBe('/');
  });
});

describe('sanitizeClientReturnTo', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves against window.location.origin, not a config value', () => {
    vi.stubGlobal('window', { location: { origin: 'https://gw.example.com' } });
    expect(sanitizeClientReturnTo('/apis?page=2')).toBe('/apis?page=2');
    expect(sanitizeClientReturnTo('http://localhost:33000/apis')).toBe('/');
  });

  it('rejects the same parser-differential bypass client-side', () => {
    vi.stubGlobal('window', { location: { origin: ORIGIN } });
    expect(sanitizeClientReturnTo('http:/\\/\\evil.com')).toBe('/');
  });
});
