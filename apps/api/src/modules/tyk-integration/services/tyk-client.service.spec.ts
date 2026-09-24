import 'reflect-metadata';
import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerService } from '../../../common/circuit-breaker/circuit-breaker.service';
import { CircuitBreakerOpenError } from '../../../common/circuit-breaker/circuit-breaker.types';
import { TykClientService } from './tyk-client.service';

/** Cache invalidation deletes Tyk's own Redis keys (see `tykCacheKeyPattern`); this suite never
 *  exercises that path, so an empty SCAN is all it needs. */
const fakeRedis = () =>
  ({ getClient: () => ({ scan: () => Promise.resolve(['0', []]), del: () => Promise.resolve(0) }) }) as never;

const ADMIN_URL = 'http://tyk:8080/tyk';
const GATEWAY_URL = 'http://tyk:8080';

/** What one `reloadGateway()` costs: fan out to the group, then block until this node has reloaded. */
const RELOAD_PATHS = ['/reload/?block=true'];

/** Every `CircuitBreakerService` handed out by `makeClient`, so its cleanup interval can be torn down. */
let createdBreakers: CircuitBreakerService[] = [];

function makeClient(
  config: Record<string, string> = {},
  circuitBreaker?: CircuitBreakerService,
): TykClientService {
  const breaker = circuitBreaker ?? new CircuitBreakerService();
  createdBreakers.push(breaker);

  return new TykClientService(
    new ConfigService({
      TYK_ADMIN_URL: ADMIN_URL,
      TYK_ADMIN_SECRET: 'admin-secret',
      TYK_GATEWAY_URL: GATEWAY_URL,
      ...config,
    }),
    breaker,
    fakeRedis(),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('TykClientService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    createdBreakers.forEach((breaker) => {
      breaker.onModuleDestroy();
    });
    createdBreakers = [];
  });

  describe('createKey', () => {
    it('maps key_hash -> keyHash and key -> key, never falling back to the raw key', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ key: 'raw-secret', status: 'ok', action: 'added', key_hash: 'e9a7cdb92e3a5546' }),
      );

      const result = await makeClient().createKey({ alias: 'k' });

      expect(result).toEqual({ keyHash: 'e9a7cdb92e3a5546', key: 'raw-secret' });
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${ADMIN_URL}/keys/create`);
      expect(init?.method).toBe('POST');
    });

    it('rejects a response without key_hash instead of persisting the raw key as an id', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ key: 'raw-secret', status: 'ok', action: 'added' }));

      await expect(makeClient().createKey({ alias: 'k' })).rejects.toThrow(BadRequestException);
    });
  });

  describe('hashed key endpoints', () => {
    it('deleteKey builds DELETE /keys/<hash>?hashed=true', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ key: 'abc123', status: 'ok', action: 'deleted' }));

      await makeClient().deleteKey('abc123');

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${ADMIN_URL}/keys/abc123?hashed=true`);
      expect(init?.method).toBe('DELETE');
    });

    it('getKey builds GET /keys/<hash>?hashed=true and returns the live key state', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ alias: 'k', rate: 5, per: 1, quota_max: 100, quota_remaining: 90 }));

      const key = await makeClient().getKey('abc123');

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${ADMIN_URL}/keys/abc123?hashed=true`);
      expect(init?.method).toBeUndefined();
      expect(key.quota_remaining).toBe(90);
    });

    it('updateKey builds PUT /keys/<hash>?hashed=true with the definition as body', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ key: 'abc123', status: 'ok', action: 'modified' }));

      await makeClient().updateKey('abc123', { rate: 10 });

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${ADMIN_URL}/keys/abc123?hashed=true`);
      expect(init?.method).toBe('PUT');
      expect(init?.body).toBe(JSON.stringify({ rate: 10 }));
    });

    it('maps a Tyk error body (lowercase `message`) to a BadRequestException', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ status: 'error', message: 'Key not found' }, 404));

      await expect(makeClient().deleteKey('missing')).rejects.toThrow('Tyk integration error: Key not found');
    });
  });

  describe('getApi', () => {
    it('builds GET /apis/<id>', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ api_id: 'api-1', name: 'x', org_id: 'org' }));

      const api = await makeClient().getApi('api-1');

      expect(fetchSpy.mock.calls[0][0]).toBe(`${ADMIN_URL}/apis/api-1`);
      expect(api).toEqual({ api_id: 'api-1', name: 'x' });
    });
  });

  describe('createApi', () => {
    const urlsOf = () => fetchSpy.mock.calls.map((call) => (call[0] as string).replace(ADMIN_URL, ''));

    it('waits for the gateway to report the new definition as loaded before returning', async () => {
      // The reload is asynchronous: GET /apis/<id> 404s for a moment after POST, and so does the
      // PUT a caller makes next. createApi must not return until the definition is really loaded.
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ key: 'api-1', status: 'ok', action: 'added' })) // POST /apis
        .mockResolvedValueOnce(jsonResponse({ status: 'ok' })) // blocking reload (per node)
        .mockResolvedValueOnce(jsonResponse({ message: 'API not found' }, 404)) // not loaded yet
        .mockResolvedValueOnce(jsonResponse({ api_id: 'api-1' })); // loaded

      const result = await makeClient().createApi({ api_id: 'api-1' });

      expect(result.apiId).toBe('api-1');
      expect(urlsOf()).toEqual(['/apis', ...RELOAD_PATHS, '/apis/api-1', '/apis/api-1']);
    });

    it('returns rather than failing when the gateway never reports the definition as loaded', async () => {
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ key: 'api-2', status: 'ok', action: 'added' }))
        .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
        .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
        .mockResolvedValue(jsonResponse({ message: 'API not found' }, 404));

      await expect(makeClient().createApi({ api_id: 'api-2' })).resolves.toMatchObject({ apiId: 'api-2' });
    });
  });

  // `/tyk/reload/group` only SCHEDULES a reload and ignores `?block=true`, so on its own every
  // mutation returned while the gateway was still serving the old config — measured on v5.15.0:
  // after a PUT, GET still answered with the previous target_url for ~1.5s, and a deleted API kept
  // answering 200. Only the single-node `/reload/?block=true` waits for the new config to be live.
  //
  // WP13a therefore drops the group reload entirely: the fan-out reloads EVERY node in
  // `TYK_ADMIN_URLS` blockingly, which is strictly stronger than scheduling one cluster-wide reload
  // and not knowing when (or whether) it landed. The only thing lost is a scheduled reload for a
  // gateway that is NOT in the node list — and such a gateway is unmanaged by definition, since the
  // node list is the configuration (Axis C / A1).
  describe('reloadGateway', () => {
    const reloadPaths = () =>
      fetchSpy.mock.calls.map((call) => (call[0] as string).replace(ADMIN_URL, '')).filter((p) => p.startsWith('/reload'));

    it('updateApi waits for the gateway to serve the new definition, like createApi does', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ key: 'api-1', status: 'ok', action: 'modified' }));

      await makeClient().updateApi('api-1', { api_id: 'api-1' });

      expect(reloadPaths()).toEqual(['/reload/?block=true']);
    });

    it('deleteApi waits for the gateway to drop the definition', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ key: 'api-1', status: 'ok', action: 'deleted' }));

      await makeClient().deleteApi('api-1');

      expect(reloadPaths()).toEqual(['/reload/?block=true']);
    });

    it('bounds the reload call instead of hanging on a half-open connection', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ status: 'ok' }));

      await makeClient().deleteApi('api-1');

      for (const [, init] of fetchSpy.mock.calls) {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
      }
    });

    it('still returns when the reload itself fails — the definition is already stored', async () => {
      // Every call in this suite passes a string URL; `fetch`'s wider input type is not in play.
      fetchSpy.mockImplementation((input) =>
        (input as string).includes('/reload')
          ? Promise.reject(new TypeError('fetch failed'))
          : Promise.resolve(jsonResponse({ key: 'api-1', status: 'ok', action: 'modified' })),
      );

      await expect(makeClient().updateApi('api-1', { api_id: 'api-1' })).resolves.toMatchObject({ status: 'ok' });
    });
  });

  describe('gatewayHealth', () => {
    it('reports version, redis status and a measured latency from GET /hello without the admin secret', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ status: 'pass', version: '5.15.0', details: { redis: { status: 'pass' } } }),
      );

      const health = await makeClient().gatewayHealth();

      expect(health).toMatchObject({
        reachable: true,
        status: 'pass',
        version: '5.15.0',
        redis: 'pass',
        error: null,
      });
      expect(health.latencyMs).toEqual(expect.any(Number));
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(`${GATEWAY_URL}/hello`);
      expect(init?.headers).toBeUndefined();
    });

    it('returns reachable:false instead of throwing on a network error', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));

      const health = await makeClient().gatewayHealth();

      expect(health).toEqual({
        reachable: false,
        status: null,
        version: null,
        redis: 'unknown',
        latencyMs: null,
        details: null,
        error: 'Gateway unreachable',
      });
    });

    it('returns reachable:false on a probe timeout', async () => {
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      fetchSpy.mockRejectedValueOnce(timeout);

      const health = await makeClient().gatewayHealth();

      expect(health.reachable).toBe(false);
      expect(health.error).toBe('Gateway health check timed out');
    });

    it('returns reachable:false when the response is not JSON', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));

      const health = await makeClient().gatewayHealth();

      expect(health.reachable).toBe(false);
      expect(health.error).toContain('502');
    });

    it('surfaces a degraded redis without marking the gateway unreachable', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ status: 'fail', version: '5.15.0', details: { redis: { status: 'fail' } } }, 503),
      );

      const health = await makeClient().gatewayHealth();

      expect(health).toMatchObject({ reachable: true, status: 'fail', redis: 'fail' });
      expect(health.error).toContain('503');
    });

    it('does not call the network when TYK_GATEWAY_URL is not configured', async () => {
      const health = await makeClient({ TYK_GATEWAY_URL: '' }).gatewayHealth();

      expect(health.reachable).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('nodeHealth (WP14)', () => {
    const NODES = 'http://n1:8081/tyk,http://n2:8081/tyk';

    it('probes /hello on every configured node with the /tyk suffix stripped', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ status: 'pass', version: '5.15.0' }));

      await makeClient({ TYK_ADMIN_URLS: NODES }).nodeHealth();

      const urls = fetchSpy.mock.calls.map(([url]) => url as string);
      expect(urls).toEqual(['http://n1:8081/hello', 'http://n2:8081/hello']);
    });

    it('reports each node by its (suffixed) admin URL, one failure not affecting the other node', async () => {
      fetchSpy.mockImplementation((input) =>
        (input as string).startsWith('http://n1')
          ? Promise.resolve(jsonResponse({ status: 'pass', version: '5.15.0' }))
          : Promise.reject(new TypeError('fetch failed')),
      );

      const results = await makeClient({ TYK_ADMIN_URLS: NODES }).nodeHealth();

      expect(results.map((r) => [r.nodeUrl, r.health.reachable])).toEqual([
        ['http://n1:8081/tyk', true],
        ['http://n2:8081/tyk', false],
      ]);
    });

    it('falls back to the single TYK_ADMIN_URL when TYK_ADMIN_URLS is unset (single-node stack)', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ status: 'pass' }));

      const results = await makeClient().nodeHealth();

      expect(results).toHaveLength(1);
      expect(results[0].nodeUrl).toBe(ADMIN_URL);
      expect(results[0].health.reachable).toBe(true);
    });
  });

  describe('reloadAllNodes (WP14)', () => {
    const NODES = 'http://n1:8081/tyk,http://n2:8081/tyk';

    it('reloads every node and returns a per-node latency, never throwing', async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ status: 'ok' }));

      const results = await makeClient({ TYK_ADMIN_URLS: NODES }).reloadAllNodes();

      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.ok).toBe(true);
        expect(result.data?.latencyMs).toEqual(expect.any(Number));
      }
      const calledPaths = fetchSpy.mock.calls.map(([url]) => url as string);
      expect(calledPaths).toEqual(['http://n1:8081/tyk/reload/?block=true', 'http://n2:8081/tyk/reload/?block=true']);
    });

    it('reports one node down without losing the others', async () => {
      fetchSpy.mockImplementation((input) =>
        (input as string).startsWith('http://n2')
          ? Promise.reject(new TypeError('fetch failed'))
          : Promise.resolve(jsonResponse({ status: 'ok' })),
      );

      const results = await makeClient({ TYK_ADMIN_URLS: NODES }).reloadAllNodes();

      expect(results).toHaveLength(2);
      const [n1, n2] = results;
      expect(n1).toMatchObject({ nodeUrl: 'http://n1:8081/tyk', ok: true });
      expect(n1.data?.latencyMs).toEqual(expect.any(Number));
      expect(n2).toMatchObject({ nodeUrl: 'http://n2:8081/tyk', ok: false });
      expect(typeof n2.error).toBe('string');
    });
  });

  describe('circuit breaker', () => {
    it('opens after 5 consecutive network failures and then rejects without touching the network', async () => {
      const breaker = new CircuitBreakerService();
      const client = makeClient({}, breaker);
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      for (let i = 0; i < 5; i++) {
        await expect(client.getApi('api-1')).rejects.toThrow('fetch failed');
      }
      expect(fetchSpy).toHaveBeenCalledTimes(5);

      // 6th call: the circuit is now OPEN, so it must fail fast with CircuitBreakerOpenError
      // instead of calling fetch again — this is what api.service.ts's toSyncError expects to catch.
      await expect(client.getApi('api-1')).rejects.toBeInstanceOf(CircuitBreakerOpenError);
      expect(fetchSpy).toHaveBeenCalledTimes(5);
    });

    it('does not trip on a Tyk-side domain error (non-2xx with a body), only on a failed fetch', async () => {
      const breaker = new CircuitBreakerService();
      const client = makeClient({}, breaker);
      fetchSpy.mockResolvedValue(jsonResponse({ status: 'error', message: 'Key not found' }, 404));

      for (let i = 0; i < 10; i++) {
        await expect(client.deleteKey('missing')).rejects.toThrow(BadRequestException);
      }

      // WP13a: one circuit per node, so the key carries the node URL.
      expect(breaker.getStatus()[`tyk:${ADMIN_URL}`].state).toBe('CLOSED');
    });
  });

  // `/tyk/reload/group` only schedules the reload, so a policy is neither live nor gone when the
  // call returns. Both waits below are what make "create a client then use it" and "revoke a client
  // then be refused" work on the first try — without them the gateway answered 403 for a new
  // client's token and 200 for a revoked one's.
  describe('policies', () => {
    // Every call in this suite passes a string URL; `fetch`'s wider input type is not in play.
    const paths = () => fetchSpy.mock.calls.map(([url]) => new URL(url as string).pathname);

    it('upserts through POST, reloads, then waits until the gateway serves the policy', async () => {
      const client = makeClient();
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ key: 'client-1', status: 'ok', action: 'added' })) // POST
        .mockResolvedValueOnce(jsonResponse({ status: 'ok' })) // blocking reload (per node)
        .mockResolvedValueOnce(jsonResponse({ status: 'error' }, 404)) // not loaded yet
        .mockResolvedValueOnce(jsonResponse({ id: 'client-1' })); // loaded

      await client.upsertPolicy({ id: 'client-1', name: 'p' });

      expect(paths()).toEqual([
        '/tyk/policies',
        '/tyk/reload/',
        '/tyk/policies/client-1', // waitForPolicy: not served yet
        '/tyk/policies/client-1', // waitForPolicy: now served
      ]);
    });

    it('waits until the gateway has actually dropped a deleted policy', async () => {
      const client = makeClient();
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ id: 'client-1' })) // exists?
        .mockResolvedValueOnce(jsonResponse({ status: 'ok', action: 'deleted' })) // DELETE
        .mockResolvedValueOnce(jsonResponse({ status: 'ok' })) // blocking reload (per node)
        .mockResolvedValueOnce(jsonResponse({ id: 'client-1' })) // still live
        .mockResolvedValueOnce(jsonResponse({ status: 'error' }, 404)); // gone

      await client.deletePolicy('client-1');

      expect(paths()).toEqual([
        '/tyk/policies/client-1', // policyExists
        '/tyk/policies/client-1', // DELETE
        '/tyk/reload/',
        '/tyk/policies/client-1', // waitForPolicy: still live
        '/tyk/policies/client-1', // waitForPolicy: gone
      ]);
    });

    it('treats a policy the gateway does not have as already deleted', async () => {
      const client = makeClient();
      // Tyk answers DELETE on a missing policy with 500 "Delete failed", which is also what a real
      // write failure looks like — so a caller must never be told the revoke failed for this reason.
      fetchSpy.mockResolvedValueOnce(jsonResponse({ status: 'error', message: 'Policy not found' }, 404));

      await expect(client.deletePolicy('client-1')).resolves.toEqual(expect.any(Array));
      expect(paths()).toEqual(['/tyk/policies/client-1']);
    });

    it('still reports a genuine delete failure to the caller', async () => {
      const client = makeClient();
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ id: 'client-1' })) // exists
        .mockResolvedValueOnce(jsonResponse({ status: 'error', message: 'Delete failed' }, 500));

      await expect(client.deletePolicy('client-1')).rejects.toThrow(BadRequestException);
    });

    it('gives up quietly rather than failing the caller when the reload never lands', async () => {
      const client = makeClient();
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ key: 'client-1', status: 'ok', action: 'added' }))
        .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
        .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
        .mockResolvedValue(jsonResponse({ status: 'error' }, 404));

      // The policy file is already written; a later reload converges, so this must not throw.
      await expect(client.upsertPolicy({ id: 'client-1' })).resolves.toEqual(expect.any(Array));
    });

    // The whole point of deleting the policy is that Tyk verifies OAuth2 tokens OFFLINE: while the
    // policy is loaded, every token already issued to the client keeps working. A delete that
    // cannot be confirmed must therefore reach the caller as a failure — `OAuthClientService.revoke`
    // catches it and refuses to report the client as revoked.
    it('does not report a policy as deleted when the gateway is unreachable', async () => {
      const client = makeClient();
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      // Previously: every failure read as "not found", so this resolved and the caller was told the
      // client was revoked while its policy — and its live tokens — were untouched.
      await expect(client.deletePolicy('client-1')).rejects.toThrow('fetch failed');
    });

    it('does not report a policy as deleted when the gateway answers 500 on the existence check', async () => {
      const client = makeClient();
      fetchSpy.mockResolvedValue(jsonResponse({ status: 'error', message: 'Something went wrong' }, 500));

      await expect(client.deletePolicy('client-1')).rejects.toThrow(BadRequestException);
    });

    it('fails closed when the gateway never drops the policy', async () => {
      const client = makeClient();
      fetchSpy
        .mockResolvedValueOnce(jsonResponse({ id: 'client-1' })) // exists?
        .mockResolvedValueOnce(jsonResponse({ status: 'ok', action: 'deleted' })) // DELETE
        .mockResolvedValueOnce(jsonResponse({ status: 'ok' })) // blocking reload (per node)
        .mockResolvedValue(jsonResponse({ id: 'client-1' })); // still serving it, forever

      // Unlike an unconfirmed LOAD (which only delays a new client), an unconfirmed REMOVAL means
      // the credentials may still be authorized.
      await expect(client.deletePolicy('client-1')).rejects.toThrow(ServiceUnavailableException);
    });

    it('still treats a genuine 404 as already deleted while the gateway is healthy', async () => {
      const client = makeClient();
      fetchSpy.mockResolvedValueOnce(jsonResponse({ status: 'error', message: 'Policy not found' }, 404));

      await expect(client.deletePolicy('client-1')).resolves.toEqual(expect.any(Array));
    });
  });
});
