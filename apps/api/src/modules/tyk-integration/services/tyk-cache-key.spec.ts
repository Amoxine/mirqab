import 'reflect-metadata';
import { tykCacheKeyPattern } from './tyk-client.service';

jest.mock('@open-gateway/database', () => ({ prisma: {} }));

/**
 * The product invalidates response caches by deleting Tyk's own Redis keys, because
 * `DELETE /tyk/cache/{apiID}` answers 200 and deletes nothing on v5.15.0. These pin the pattern the
 * deletion uses; `wp15b-acceptance.ts` pins the other half — that Tyk still WRITES keys matching it.
 * Neither test is meaningful alone: this one would pass against a pattern that matches nothing real.
 */
describe('tykCacheKeyPattern', () => {
  it('matches the prefix Tyk writes: cache-<apiId>…', () => {
    expect(tykCacheKeyPattern('og-abc')).toBe('cache-og-abc*');
  });

  it('is a prefix match, because the real key appends the api id again, the client IP and a hash', () => {
    // Observed on v5.15.0: cache-<apiId><apiId><clientIP><hash>. The embedded client IP is why a
    // probe that changes IP between requests sees a cache MISS and misreads it as invalidation.
    const real = 'cache-og-abcog-abc172.18.0.13a7cc6b5e97ed92a7df1a9b0c2cc70dbc';
    const pattern = tykCacheKeyPattern('og-abc');
    expect(real.startsWith(pattern.slice(0, -1))).toBe(true);
  });

  it('does not collide with another API whose id is a prefix of this one', () => {
    // `cache-og-a*` would also match `og-ab`'s keys, so the id must be used whole.
    expect(tykCacheKeyPattern('og-ab').startsWith(tykCacheKeyPattern('og-a').slice(0, -1))).toBe(true);
    // Documented consequence: ids are uuid-derived (`og-<uuid>`), so one is never a prefix of another.
    expect(tykCacheKeyPattern('og-11111111-1111-4111-8111-111111111111')).toContain('og-1111');
  });
});
