import { describe, expect, it } from 'vitest';
import { MASK, maskInternalDetails } from './audit-details-display';

describe('maskInternalDetails', () => {
  it.each([
    ['the gateway node a sync ran against', { node: 'tyk-gateway:8081' }],
    ['the node’s URL', { nodeUrl: 'http://tyk-gateway:8081' }],
    ['the gateway’s own id for an API', { tykApiId: 'a1b2c3' }],
    ['any other gateway-internal id', { tykKeyId: 'k-9', tykPolicyId: 'p-1', tykOrgId: 'o-1' }],
  ])('hides %s, whatever it holds', (_name, details) => {
    const masked = maskInternalDetails(details) as Record<string, unknown>;
    for (const key of Object.keys(details)) expect(masked[key]).toBe(MASK);
  });

  it.each([
    ['a docker or cluster service name', 'http://tyk-gateway:8081/tyk/apis'],
    ['a single-label host', 'http://gateway/health'],
    ['localhost', 'http://localhost:3000/x'],
    ['a loopback address', 'http://127.0.0.1:8080'],
    ['a 10.x address', 'http://10.1.2.3/api'],
    ['a 192.168.x address', 'https://192.168.0.9/'],
    ['a 172.16-31 address', 'http://172.20.1.2:9000'],
    ['an .internal name', 'https://gw.prod.internal/v1'],
    ['a .svc.cluster.local name', 'http://tyk.default.svc.cluster.local:8080'],
    ['an IPv6 loopback', 'http://[::1]:8080/'],
  ])('hides a URL to %s wherever it is, even under a key that means nothing', (_name, url) => {
    expect(maskInternalDetails({ url })).toEqual({ url: MASK });
    expect(maskInternalDetails({ a: [{ b: url }] })).toEqual({ a: [{ b: MASK }] });
  });

  it.each([
    ['a public API', 'https://api.example.com/v1/orders'],
    ['a public IP', 'http://8.8.8.8/'],
    ['172.15 (outside the private range)', 'http://172.15.0.1/'],
    ['172.32 (outside the private range)', 'http://172.32.0.1/'],
    ['a plain value that is not a URL', 'orders'],
  ])('keeps %s', (_name, value) => {
    expect(maskInternalDetails({ url: value })).toEqual({ url: value });
  });

  it('hides an internal URL inside free text and keeps the rest of the sentence', () => {
    expect(maskInternalDetails({ error: 'could not reach http://tyk-gateway:8080/tyk/apis, then retried https://api.example.com/x' })).toEqual({
      error: `could not reach ${MASK}, then retried https://api.example.com/x`,
    });
  });

  it('keeps what is not sensitive: numbers, booleans, null, ids, nested objects and arrays', () => {
    const details = { resourceId: 'api-1', count: 3, ok: true, none: null, nested: { list: [1, 'two', { three: 3 }] } };
    expect(maskInternalDetails(details)).toEqual(details);
  });

  it('hides the sensitive part of a larger record and leaves its siblings readable', () => {
    expect(maskInternalDetails({ resourceId: 'api-1', syncStatus: 'SYNCED', node: 'tyk-gateway:8081', tykApiId: 'x' })).toEqual({
      resourceId: 'api-1',
      syncStatus: 'SYNCED',
      node: MASK,
      tykApiId: MASK,
    });
  });

  it('does not change what it was given: the stored entry is displayed differently, never edited', () => {
    const details = { node: 'tyk-gateway:8081', nested: { url: 'http://tyk-gateway:8081' } };
    const before = JSON.stringify(details);
    maskInternalDetails(details);
    expect(JSON.stringify(details)).toBe(before);
  });

  it('survives a very deep value (stops at a depth guard rather than overflowing the stack)', () => {
    let deep: Record<string, unknown> = { node: 'x' };
    for (let i = 0; i < 20_000; i += 1) deep = { next: deep };
    expect(() => maskInternalDetails(deep)).not.toThrow();
  });

  it('passes null and primitives through', () => {
    expect(maskInternalDetails(null)).toBeNull();
    expect(maskInternalDetails(7)).toBe(7);
    expect(maskInternalDetails('plain')).toBe('plain');
  });

  describe('credentials inside a text value, under any key', () => {
    const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

    it.each([
      ['a Bearer token', 'Authorization: Bearer abc123DEF456ghi789', `Authorization: Bearer ${MASK}`],
      ['a Bearer token, any case', 'sent bearer abc123DEF456ghi789 to the upstream', `sent bearer ${MASK} to the upstream`],
      ['a JWT', `token ${JWT} was rejected`, `token ${MASK} was rejected`],
      ['a Bearer JWT', `Bearer ${JWT}`, `Bearer ${MASK}`],
      ['a JWT with no signature', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0NTY3ODkwIn0.', MASK],
      ['a JWT in a public URL', `https://api.example.com/cb/${JWT}`, `https://api.example.com/cb/${MASK}`],
    ])('hides %s and keeps the words around it', (_name, text, expected) => {
      expect(maskInternalDetails({ note: text })).toEqual({ note: expected });
      expect(maskInternalDetails([{ deep: { note: text } }])).toEqual([{ deep: { note: expected } }]);
    });

    it.each([
      ['the word Bearer on its own', 'Send it as a Bearer token'],
      ['a short word after Bearer', 'Bearer abc'],
      ['eyJ with no dots', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
      ['a dotted version number', 'upstream 1.2.3 answered'],
      ['two dotted words', 'orders.billing.v2 is synced'],
    ])('keeps %s', (_name, text) => {
      expect(maskInternalDetails({ note: text })).toEqual({ note: text });
    });

    it('hides both an internal URL and a credential in one text', () => {
      expect(maskInternalDetails({ error: `GET http://tyk-gateway:8080/x with Bearer ${JWT} failed` })).toEqual({
        error: `GET ${MASK} with Bearer ${MASK} failed`,
      });
    });
  });
});
