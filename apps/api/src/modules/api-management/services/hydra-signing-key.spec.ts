import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { fetchAccessTokenSigningKey } from './hydra-signing-key';

const ADMIN_URL = 'http://hydra:4445';

const keyPair = (kid: string) => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' },
    base64Pem: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }).toString()).toString('base64'),
  };
};

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'access-token-key', use: 'sig', alg: 'RS256' };
const expectedPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('fetchAccessTokenSigningKey', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('reads the access-token key set, not the published JWKS', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ keys: [jwk] }));

    await fetchAccessTokenSigningKey(ADMIN_URL);

    // The public /.well-known/jwks.json also carries the id-token key and never says which is which.
    expect(new URL(fetchSpy.mock.calls[0]?.[0] as URL).pathname).toBe('/admin/keys/hydra.jwt.access-token');
  });

  it('returns the key as the base64 PEM Tyk expects in jwt_source', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ keys: [jwk] }));

    const encoded = await fetchAccessTokenSigningKey(ADMIN_URL);

    const pem = Buffer.from(encoded, 'base64').toString();
    expect(pem).toBe(expectedPem);
    // Round-trips back to the same key, i.e. it really is the public half.
    expect(createPublicKey(pem).export({ format: 'jwk' })).toMatchObject({ n: jwk.n, e: jwk.e });
  });

  it('skips a key that cannot verify an RS256 access token', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ keys: [{ ...jwk, use: 'enc' }, { ...jwk, kty: 'EC', crv: 'P-256' }, jwk] }),
    );

    await expect(fetchAccessTokenSigningKey(ADMIN_URL)).resolves.toBe(
      Buffer.from(expectedPem).toString('base64'),
    );
  });

  // A rotation leaves BOTH keys in the set, and a JWK carries no created_at or "active" marker, so
  // order is the only signal there is. Hydra returns the set newest-first (verified on v26.2.0:
  // keys created A, B, C come back C, B, A) and signs with the first usable one — pinning any other
  // element would 401 every caller until the next rotation.
  describe('a rotated key set (more than one RS256 key)', () => {
    it('pins the first key, which is the one Hydra is signing with', async () => {
      const current = keyPair('rotated-in');
      const retired = keyPair('rotated-out');
      fetchSpy.mockResolvedValue(jsonResponse({ keys: [current.jwk, retired.jwk] }));

      await expect(fetchAccessTokenSigningKey(ADMIN_URL)).resolves.toBe(current.base64Pem);
    });

    it('skips unusable keys before choosing, rather than counting them as the first', async () => {
      const current = keyPair('rotated-in');
      const retired = keyPair('rotated-out');
      fetchSpy.mockResolvedValue(
        jsonResponse({
          keys: [
            { ...keyPair('encryption').jwk, use: 'enc' },
            { ...keyPair('elliptic').jwk, kty: 'EC', crv: 'P-256' },
            current.jwk,
            retired.jwk,
          ],
        }),
      );

      await expect(fetchAccessTokenSigningKey(ADMIN_URL)).resolves.toBe(current.base64Pem);
    });
  });

  it('bounds the admin call instead of hanging on a half-open connection', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ keys: [jwk] }));

    await fetchAccessTokenSigningKey(ADMIN_URL);

    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('fails loudly when the provider publishes no usable key', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ keys: [] }));

    await expect(fetchAccessTokenSigningKey(ADMIN_URL)).rejects.toThrow('no RS256 signing key');
  });

  it('fails loudly when the admin API rejects the read', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: 'nope' }, 500));

    await expect(fetchAccessTokenSigningKey(ADMIN_URL)).rejects.toThrow('HTTP 500');
  });
});
