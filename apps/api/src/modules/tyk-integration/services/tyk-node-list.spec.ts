import 'reflect-metadata';
import { parseNodeUrls } from './tyk-client.service';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

describe('parseNodeUrls (WP13a: the node list is configuration, not a resource)', () => {
  const FALLBACK = 'http://tyk-gateway:8081/tyk';

  it('falls back to the single TYK_ADMIN_URL, so a single-node stack is unchanged', () => {
    expect(parseNodeUrls('', FALLBACK)).toEqual([FALLBACK]);
  });

  it('splits a comma-separated list and keeps declaration order', () => {
    expect(parseNodeUrls('http://a:8081/tyk,http://b:8081/tyk,http://c:8081/tyk', FALLBACK)).toEqual([
      'http://a:8081/tyk',
      'http://b:8081/tyk',
      'http://c:8081/tyk',
    ]);
  });

  it('keeps the /tyk suffix — WP14 strips it for /hello, which is served at the root', () => {
    expect(parseNodeUrls('http://a:8081/tyk', FALLBACK)[0].endsWith('/tyk')).toBe(true);
  });

  it('tolerates whitespace around entries', () => {
    expect(parseNodeUrls(' http://a:8081/tyk , http://b:8081/tyk ', FALLBACK)).toEqual([
      'http://a:8081/tyk',
      'http://b:8081/tyk',
    ]);
  });

  it('drops blank entries from a trailing or doubled comma', () => {
    expect(parseNodeUrls('http://a:8081/tyk,,http://b:8081/tyk,', FALLBACK)).toEqual([
      'http://a:8081/tyk',
      'http://b:8081/tyk',
    ]);
  });

  it('de-duplicates, including across a trailing slash', () => {
    // Otherwise the same node is written twice and double-counted in drift's perNode map.
    expect(parseNodeUrls('http://a:8081/tyk,http://a:8081/tyk/,http://a:8081/tyk', FALLBACK)).toEqual([
      'http://a:8081/tyk',
    ]);
  });

  it('returns an empty list when neither the list nor the fallback is configured', () => {
    // Callers warn about this at construction; inventing a node would be worse.
    expect(parseNodeUrls('', '')).toEqual([]);
  });
});
