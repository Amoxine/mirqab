import { generateKeyPairSync } from 'node:crypto';
import { kidOf, resetJwksCache, resolveSigningKey } from './jwks';

const JWKS_URI = 'http://hydra:4444/.well-known/jwks.json';

const keyPair = (kid: string) => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' },
    pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
};

const stubJwks = (keys: unknown[]) =>
  jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ keys }), { status: 200 }));

beforeEach(() => {
  resetJwksCache();
  jest.restoreAllMocks();
});

describe('resolveSigningKey', () => {
  it('imports the JWK for a kid as a PEM and caches it', async () => {
    const signing = keyPair('kid-1');
    const fetchMock = stubJwks([signing.jwk]);

    await expect(resolveSigningKey(JWKS_URI, 'kid-1')).resolves.toBe(signing.pem);
    await expect(resolveSigningKey(JWKS_URI, 'kid-1')).resolves.toBe(signing.pem);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores keys that cannot verify an RS256 access token', async () => {
    const usable = keyPair('good');
    stubJwks([
      { ...keyPair('encryption-key').jwk, use: 'enc' },
      { ...keyPair('wrong-alg').jwk, alg: 'RS512' },
      { kty: 'oct', kid: 'symmetric', k: 'AAAA' },
      usable.jwk,
    ]);

    await expect(resolveSigningKey(JWKS_URI, 'good')).resolves.toBe(usable.pem);
    await expect(resolveSigningKey(JWKS_URI, 'encryption-key')).rejects.toThrow('No JWKS signing key');
    await expect(resolveSigningKey(JWKS_URI, 'wrong-alg')).rejects.toThrow('No JWKS signing key');
    await expect(resolveSigningKey(JWKS_URI, 'symmetric')).rejects.toThrow('No JWKS signing key');
  });

  it('does not re-fetch the JWKS for every unknown kid', async () => {
    // A forged header carrying a random kid must not become an upstream request per call.
    const fetchMock = stubJwks([keyPair('kid-1').jwk]);

    await expect(resolveSigningKey(JWKS_URI, 'forged-a')).rejects.toThrow('No JWKS signing key');
    await expect(resolveSigningKey(JWKS_URI, 'forged-b')).rejects.toThrow('No JWKS signing key');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Revoking a signing key means withdrawing it from the JWKS, so these bound how long that takes
   * to bite. The cache hit used to have no expiry at all, and crucially it did not self-heal in the
   * attack case: an attacker holding the compromised key presents only that kid, which is always a
   * hit, so they never trigger the refetch that would evict it.
   */
  describe('revocation is bounded', () => {
    const TEN_MINUTES = 10 * 60_000;

    /** Move the clock on without touching the timers the fetch mock relies on. */
    const advance = (ms: number) => {
      const target = Date.now() + ms;
      return jest.spyOn(Date, 'now').mockReturnValue(target);
    };

    it('stops verifying a kid that has been withdrawn from the JWKS, once the ceiling passes', async () => {
      const compromised = keyPair('kid-1');
      const fetchMock = stubJwks([compromised.jwk]);

      await expect(resolveSigningKey(JWKS_URI, 'kid-1')).resolves.toBe(compromised.pem);

      // The key is revoked at Hydra, and the attacker keeps presenting the same kid — nothing else
      // is driving traffic, so only the ceiling can evict it.
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ keys: [] }), { status: 200 }));
      const clock = advance(TEN_MINUTES + 1_000);

      await expect(resolveSigningKey(JWKS_URI, 'kid-1')).rejects.toThrow('No JWKS signing key');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      clock.mockRestore();
    });

    it('does NOT fall back on the cached key when the refresh fails past the ceiling', async () => {
      // Fail-closed: otherwise anyone who can keep the JWKS endpoint unreachable extends a revoked
      // key one window at a time. This is also why the ceiling is measured from the last SUCCESSFUL
      // fetch — refreshing it on a failed attempt would resurrect the cache on every outage.
      const compromised = keyPair('kid-1');
      const fetchMock = stubJwks([compromised.jwk]);
      await expect(resolveSigningKey(JWKS_URI, 'kid-1')).resolves.toBe(compromised.pem);

      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const clock = advance(TEN_MINUTES + 1_000);

      const failedAt = Date.now();
      await expect(resolveSigningKey(JWKS_URI, 'kid-1')).rejects.toThrow('fetch failed');

      // The discriminating case: a request just AFTER that failed refresh, still inside the window
      // the failed attempt would have opened. If the ceiling were measured from the last attempt
      // rather than the last success, this would be served from cache and the revoked key would
      // live on in 10-minute increments for as long as the JWKS endpoint stays unreachable.
      clock.mockReturnValue(failedAt + 30_000);
      await expect(resolveSigningKey(JWKS_URI, 'kid-1')).rejects.toThrow();
      clock.mockRestore();
    });

    it('keeps serving a cached kid inside the ceiling without re-fetching', async () => {
      const signing = keyPair('kid-1');
      const fetchMock = stubJwks([signing.jwk]);

      await expect(resolveSigningKey(JWKS_URI, 'kid-1')).resolves.toBe(signing.pem);
      const clock = advance(TEN_MINUTES - 5_000);
      await expect(resolveSigningKey(JWKS_URI, 'kid-1')).resolves.toBe(signing.pem);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      clock.mockRestore();
    });
  });

  it('bounds the JWKS fetch instead of hanging the request that triggered it', async () => {
    const fetchMock = stubJwks([keyPair('kid-1').jwk]);

    await resolveSigningKey(JWKS_URI, 'kid-1');

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces a JWKS endpoint that is down instead of treating it as "no such key"', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status: 503 }));

    await expect(resolveSigningKey(JWKS_URI, 'kid-1')).rejects.toThrow('JWKS fetch failed: 503');
  });
});

describe('kidOf', () => {
  const header = (value: object) =>
    `${Buffer.from(JSON.stringify(value)).toString('base64url')}.payload.signature`;

  it('reads the kid out of a JWT header', () => {
    expect(kidOf(header({ alg: 'RS256', kid: 'kid-1' }))).toBe('kid-1');
  });

  it('rejects a header with no kid', () => {
    expect(() => kidOf(header({ alg: 'RS256' }))).toThrow('no kid');
  });

  it('rejects a token that is not a JWT at all', () => {
    expect(() => kidOf('')).toThrow('Malformed JWT');
  });
});
