import { parseCookieSecure, parseTrustProxyHops } from './env';

describe('parseCookieSecure', () => {
  it('defaults to NODE_ENV === production when unset', () => {
    expect(parseCookieSecure(undefined, 'production')).toBe(true);
    expect(parseCookieSecure(undefined, 'development')).toBe(false);
    expect(parseCookieSecure(undefined, undefined)).toBe(false);
    expect(parseCookieSecure('', 'production')).toBe(true);
  });

  it('lets COOKIE_SECURE override NODE_ENV in both directions', () => {
    expect(parseCookieSecure('true', 'development')).toBe(true);
    expect(parseCookieSecure(' TRUE ', 'development')).toBe(true);
    expect(parseCookieSecure('false', 'production')).toBe(false);
    expect(parseCookieSecure('False', 'production')).toBe(false);
  });

  it('ignores unrecognised values instead of guessing', () => {
    expect(parseCookieSecure('1', 'production')).toBe(true);
    expect(parseCookieSecure('yes', 'development')).toBe(false);
  });
});

describe('parseTrustProxyHops', () => {
  it('defaults to 0 hops without a warning when unset or blank', () => {
    expect(parseTrustProxyHops(undefined)).toEqual({ hops: 0, invalid: false });
    expect(parseTrustProxyHops('')).toEqual({ hops: 0, invalid: false });
    expect(parseTrustProxyHops('  ')).toEqual({ hops: 0, invalid: false });
  });

  it('accepts non-negative integers', () => {
    expect(parseTrustProxyHops('0')).toEqual({ hops: 0, invalid: false });
    expect(parseTrustProxyHops('1')).toEqual({ hops: 1, invalid: false });
    expect(parseTrustProxyHops(' 2 ')).toEqual({ hops: 2, invalid: false });
  });

  // `true` would trust every X-Forwarded-For entry, so a client could spoof its way out of the limit.
  it.each(['true', '-1', '1.5', 'abc', '1e3', '0x2'])('falls back to 0 and flags %s', (raw) => {
    expect(parseTrustProxyHops(raw)).toEqual({ hops: 0, invalid: true });
  });
});
