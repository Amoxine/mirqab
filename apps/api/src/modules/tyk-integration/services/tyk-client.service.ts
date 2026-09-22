import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerService } from '../../../common/circuit-breaker/circuit-breaker.service';

/**
 * A non-2xx answer from Tyk, carrying the status so a caller can tell a genuine 404 ("the gateway
 * does not have this") from a failure ("the gateway could not answer"). Collapsing the two is how
 * a revoke came to report success while the policy was still live.
 *
 * Deliberately a `BadRequestException` subclass: `KeyService.deleteTykKey` and the sync-error
 * mapping both branch on `instanceof BadRequestException`, and the HTTP status the client sees is
 * unchanged.
 */
export class TykResponseError extends BadRequestException {
  constructor(
    message: string,
    /** The status Tyk answered with, not the one this exception maps to. */
    readonly upstreamStatus: number,
  ) {
    super(message);
  }
}

/** Body of Tyk's status-style responses (create/update/delete). Errors use `Message` (apis) or `message` (keys). */
interface TykStatusBody {
  key?: string;
  key_hash?: string;
  api_id?: string;
  status?: string;
  action?: string;
  Message?: string;
  message?: string;
}

type TykApiResponse = TykStatusBody & Record<string, unknown>;

interface TykCreateResult {
  apiId: string;
  key: string;
  status: string;
  action: string;
  /** One entry per node in `TYK_ADMIN_URLS`. Callers that only need `apiId` can ignore it. */
  nodes: NodeOutcome[];
}

/** Live key state as returned by `GET /tyk/keys/{hash}?hashed=true` (Tyk's own snake_case fields). */
export interface TykKeyState {
  alias?: string;
  rate?: number;
  per?: number;
  quota_max?: number;
  quota_remaining?: number;
  quota_renewal_rate?: number;
  quota_renews?: number;
  access_rights?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Result of the unauthenticated `GET {gateway}/hello` probe. Never thrown — see `gatewayHealth()`. */
export interface TykGatewayHealth {
  reachable: boolean;
  /** Tyk's own verdict (`pass` | `warn` | `fail`); null when unreachable. */
  status: string | null;
  version: string | null;
  redis: 'pass' | 'fail' | 'unknown';
  /** Round-trip time of the probe in ms; null when the gateway could not be reached. */
  latencyMs: number | null;
  /** Raw per-dependency health from Tyk (`details`); null when unreachable. */
  details: Record<string, { status?: string } | undefined> | null;
  error: string | null;
}

interface TykHelloBody {
  status?: string;
  version?: string;
  details?: Record<string, { status?: string } | undefined>;
}

const HEALTH_TIMEOUT_MS = 3000;

/**
 * Every admin call is bounded. Without a timeout a half-open connection to the gateway hangs the
 * request handler forever AND defeats the circuit breaker by construction: the breaker counts
 * `fetch` rejections, and a hang never rejects. Generous next to the health probe because a
 * blocking reload legitimately takes ~1s and grows with the number of definitions.
 */
const ADMIN_TIMEOUT_MS = 10_000;

/**
 * Prefix of the circuit tracking Tyk Admin API calls. The circuit is keyed
 * `${CIRCUIT_NAME}:${nodeUrl}` — ONE BREAKER PER NODE (WP13a).
 *
 * It used to be this bare constant for every call. `CircuitBreakerService` keys its state by name,
 * so a single dead node tripped the one shared circuit and every subsequent write to the HEALTHY
 * nodes was refused with `CircuitBreakerOpenError` — one node down took the whole fan-out with it,
 * which is exactly the failure multi-node is supposed to survive.
 */
const CIRCUIT_NAME = 'tyk';

/** Result of one node's participation in a fan-out write. Never throws; failure is a value. */
export interface NodeOutcome<T = unknown> {
  nodeUrl: string;
  ok: boolean;
  data?: T;
  error?: string;
}

// For ~300ms after a POST /apis the gateway still answers 404 on GET and PUT for the new api_id, so
// "create then immediately activate/edit" failed with "API not found" (reproduced 5/5). GET becomes
// available at the same instant as PUT, so it is the readiness signal. 10 x 100ms comfortably covers
// the observed window; since `reloadGateway` blocks, the first check usually already passes.
const API_LOAD_POLL_MS = 100;
const API_LOAD_ATTEMPTS = 10;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse `TYK_ADMIN_URLS` into the node list, falling back to the single `TYK_ADMIN_URL`.
 *
 * Exported for the reconcile service and its tests: drift and fan-out MUST agree on the node set,
 * and duplicates would double-count a node in both. Order is preserved (first entry is the node
 * reads go to); blanks are dropped and trailing slashes normalised so `…/tyk` and `…/tyk/` are one
 * node, not two.
 */
export function parseNodeUrls(raw: string, fallback: string): string[] {
  const seen = new Set<string>();
  const urls = (raw || fallback)
    .split(',')
    .map((u) => u.trim().replace(/\/+$/, ''))
    .filter((u) => u.length > 0)
    .filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
  return urls.length > 0 ? urls : [];
}

@Injectable()
export class TykClientService {
  private readonly logger = new Logger(TykClientService.name);
  private readonly adminApiUrl: string;
  private readonly adminKey: string;
  private readonly gatewayUrl: string;
  /** Every gateway node's admin URL, `/tyk` suffix included. Length 1 on a single-node stack. */
  private readonly nodeUrls: string[];

  constructor(
    private readonly configService: ConfigService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {
    this.adminApiUrl = this.configService.get('TYK_ADMIN_URL', '');
    this.adminKey = this.configService.get('TYK_ADMIN_SECRET', '');
    this.gatewayUrl = this.configService.get('TYK_GATEWAY_URL', '');

    // The node list is CONFIGURATION, not a resource (Axis C / A1): no table, no CRUD route.
    // Defaults to the single `TYK_ADMIN_URL` so a single-node stack behaves exactly as before.
    // Every entry carries the `/tyk` suffix, like `TYK_ADMIN_URL` itself — WP14's health probe
    // strips it, because `/hello` is served at the control port's root.
    this.nodeUrls = parseNodeUrls(this.configService.get('TYK_ADMIN_URLS', ''), this.adminApiUrl);

    if (!this.adminApiUrl || !this.adminKey) {
      this.logger.warn(
        'Tyk Admin URL or Secret not configured. Tyk integration will fail at runtime.',
      );
    }
    if (this.nodeUrls.length > 1) {
      this.logger.log(`Tyk fan-out across ${String(this.nodeUrls.length)} nodes`);
    }
  }

  /** The configured gateway nodes, in declaration order. Read-only: the list is config. */
  get nodes(): readonly string[] {
    return this.nodeUrls;
  }

  /**
   * Run `write` against every configured node and return one outcome per node. Never throws and
   * never short-circuits: a node that is down must not stop the healthy ones from being written,
   * which is the whole point of the per-node circuit breaker above.
   *
   * Sequential rather than parallel on purpose — the nodes share one Redis, and a parallel
   * definition write plus reload on three nodes races the gateway's own file-then-reload sequence.
   * Three nodes at ~1 s each is well inside the request budget.
   */
  async forEachNode<T>(write: (nodeUrl: string) => Promise<T>): Promise<NodeOutcome<T>[]> {
    return (await this.forEachNodeRaw(write)).map(({ outcome }) => outcome);
  }

  /**
   * As `forEachNode`, but keeps each failure's original error object alongside the serialisable
   * outcome. `fanOut` needs the original: `TykResponseError` is a `BadRequestException` subclass on
   * purpose (see its doc comment) and `KeyService.deleteTykKey` plus the sync-error mapping both
   * branch on `instanceof BadRequestException`. Re-wrapping it would silently change those paths.
   */
  private async forEachNodeRaw<T>(
    write: (nodeUrl: string) => Promise<T>,
  ): Promise<{ outcome: NodeOutcome<T>; raw?: Error }[]> {
    const results: { outcome: NodeOutcome<T>; raw?: Error }[] = [];
    for (const nodeUrl of this.nodeUrls) {
      try {
        results.push({ outcome: { nodeUrl, ok: true, data: await write(nodeUrl) } });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Tyk node ${nodeUrl} failed: ${error}`);
        results.push({
          outcome: { nodeUrl, ok: false, error },
          raw: err instanceof Error ? err : new Error(error),
        });
      }
    }
    return results;
  }

  /**
   * Fan out a write, then fail only if EVERY node refused it. One node down is a partial success
   * the caller reports as 207; all nodes down is a genuine gateway failure and throws exactly as
   * the single-node code did, so existing error handling still works.
   */
  private async fanOut<T>(write: (nodeUrl: string) => Promise<T>): Promise<NodeOutcome<T>[]> {
    const results = await this.forEachNodeRaw(write);
    if (results.length > 0 && results.every((r) => !r.outcome.ok)) {
      // Rethrow the FIRST node's original error rather than a new one: on a single-node stack this
      // path is the only path, and callers still expect the exact exception type Tyk produced.
      throw results[0].raw ?? new BadGatewayException('Tyk gateway unreachable');
    }
    return results.map(({ outcome }) => outcome);
  }

  /** Read a definition from one specific node — the drift check's per-node fetch. */
  async getApiFromNode(apiId: string, nodeUrl: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(`/apis/${encodeURIComponent(apiId)}`, {}, nodeUrl);
  }

  async createApi(tykDef: Record<string, unknown>): Promise<TykCreateResult> {
    this.logger.debug('Creating API in Tyk');

    const outcomes = await this.fanOut(async (nodeUrl) => {
      const body = await this.request('/apis', { method: 'POST', body: JSON.stringify(tykDef) }, nodeUrl);
      await this.reloadNode(nodeUrl);
      return body;
    });

    // Every node was sent the same document, so any successful node's answer is THE answer; the
    // fan-out has already thrown if none of them accepted it.
    const response = outcomes.find((o) => o.ok)?.data ?? {};
    const apiId = response.key ?? response.api_id ?? '';
    if (apiId) await this.waitForApiLoaded(apiId);

    return {
      apiId,
      key: response.key ?? '',
      status: response.status ?? 'ok',
      action: response.action ?? 'created',
      nodes: outcomes,
    };
  }

  /**
   * Block until the gateway reports the definition as loaded, so a caller that mutates it straight
   * after creating it does not race the asynchronous reload. Never throws: the definition is
   * already on disk, and a later reload picks it up regardless.
   */
  private async waitForApiLoaded(apiId: string): Promise<void> {
    for (let attempt = 0; attempt < API_LOAD_ATTEMPTS; attempt++) {
      try {
        await this.request(`/apis/${encodeURIComponent(apiId)}`);
        return;
      } catch {
        // Not loaded yet — keep polling.
      }
      await sleep(API_LOAD_POLL_MS);
    }
    this.logger.warn(`Gateway has not loaded API ${apiId} yet; a later reload will pick it up`);
  }

  async getApi(apiId: string): Promise<Record<string, unknown>> {
    this.logger.debug(`Fetching API ${apiId} from Tyk`);

    return this.request<Record<string, unknown>>(`/apis/${encodeURIComponent(apiId)}`);
  }

  async updateApi(
    apiId: string,
    tykDef: Record<string, unknown>,
  ): Promise<TykApiResponse & { nodes: NodeOutcome[] }> {
    this.logger.debug(`Updating API ${apiId} in Tyk`);

    const outcomes = await this.fanOut(async (nodeUrl) => {
      const body = await this.request<TykApiResponse>(
        `/apis/${apiId}`,
        { method: 'PUT', body: JSON.stringify(tykDef) },
        nodeUrl,
      );
      await this.reloadNode(nodeUrl);
      return body;
    });
    return { ...(outcomes.find((o) => o.ok)?.data ?? {}), nodes: outcomes };
  }

  async deleteApi(apiId: string): Promise<NodeOutcome[]> {
    this.logger.debug(`Deleting API ${apiId} from Tyk`);

    return this.fanOut(async (nodeUrl) => {
      const body = await this.request(`/apis/${apiId}`, { method: 'DELETE' }, nodeUrl);
      await this.reloadNode(nodeUrl);
      return body;
    });
  }

  /**
   * Create a key. `keyHash` is Tyk's `key_hash` (murmur hash) — the value to persist and to
   * address the key by afterwards. `key` is the raw secret, shown to the user exactly once.
   */
  async createKey(keyDef: Record<string, unknown>): Promise<{ keyHash: string; key: string }> {
    this.logger.debug('Creating API key in Tyk');

    const response = await this.request('/keys/create', {
      method: 'POST',
      body: JSON.stringify(keyDef),
    });

    if (!response.key_hash || !response.key) {
      throw new BadRequestException('Tyk integration error: key creation response was incomplete');
    }

    return { keyHash: response.key_hash, key: response.key };
  }

  async getKey(keyHash: string): Promise<TykKeyState> {
    this.logger.debug(`Fetching API key ${keyHash} from Tyk`);

    return this.request<TykKeyState>(`/keys/${encodeURIComponent(keyHash)}?hashed=true`);
  }

  async updateKey(keyHash: string, keyDef: Record<string, unknown>): Promise<void> {
    this.logger.debug(`Updating API key ${keyHash} in Tyk`);

    await this.request(`/keys/${encodeURIComponent(keyHash)}?hashed=true`, {
      method: 'PUT',
      body: JSON.stringify(keyDef),
    });
  }

  async deleteKey(keyHash: string): Promise<void> {
    this.logger.debug(`Deleting API key ${keyHash} from Tyk`);

    await this.request(`/keys/${encodeURIComponent(keyHash)}?hashed=true`, {
      method: 'DELETE',
    });
  }

  /**
   * Create or replace a Tyk policy (the rate / quota / access-rights record a JWT is mapped to).
   *
   * `POST /tyk/policies` is an upsert on the file-backed store: it writes `<policy id>.json` into
   * the gateway's `policies.policy_path`, truncating an existing file, so re-posting the same id
   * replaces it (verified on v5.15.0 — a second POST answers `action: "added"` and the new limits
   * take effect). The gateway only serves policies after a reload, exactly like API definitions.
   *
   * Requires `TYK_GW_POLICIES_POLICYPATH` to point at a writable directory — without it the gateway
   * answers 500 "Failed to create file!".
   */
  async upsertPolicy(policy: Record<string, unknown>): Promise<NodeOutcome[]> {
    this.logger.debug('Upserting policy in Tyk');

    const outcomes = await this.fanOut(async (nodeUrl) => {
      const body = await this.request(
        '/policies',
        { method: 'POST', body: JSON.stringify(policy) },
        nodeUrl,
      );
      await this.reloadNode(nodeUrl);
      return body;
    });

    // Same asynchronous-reload race as API definitions: until the reload lands, a token mapped to
    // this policy is rejected with "Could not find a valid policy to apply to this token!". The
    // caller hands the credentials straight to a user, so wait for them to actually work.
    const policyId = policy.id;
    if (typeof policyId === 'string') await this.waitForPolicy(policyId, true);
    return outcomes;
  }

  /**
   * Remove a policy, idempotently. Every token mapped to it is denied once the reload lands — which
   * is what actually revokes an OAuth2 client, since Tyk verifies its tokens offline and cannot know
   * the credentials were deleted at the provider.
   *
   * The existence check is not redundant: Tyk answers a policy it does not have with 500
   * `Delete failed`, the same body a genuine write failure produces (verified on v5.15.0 — only GET
   * distinguishes them, with 404 `Policy not found`). Without it a caller could never finish a
   * half-done revoke, because "already gone" would keep reading as "the gateway refused".
   */
  async deletePolicy(policyId: string): Promise<NodeOutcome[]> {
    this.logger.debug(`Deleting policy ${policyId} from Tyk`);
    const path = `/policies/${encodeURIComponent(policyId)}`;

    if (!(await this.policyExists(policyId))) {
      this.logger.warn(`Policy ${policyId} is not on the gateway; nothing to delete`);
      return [];
    }

    const outcomes = await this.fanOut(async (nodeUrl) => {
      const body = await this.request(path, { method: 'DELETE' }, nodeUrl);
      await this.reloadNode(nodeUrl);
      return body;
    });
    await this.waitForPolicy(policyId, false);
    return outcomes;
  }

  /**
   * Whether the gateway currently serves this policy. Reflects the loaded set, not the files.
   *
   * Only a genuine 404 answers `false`. Anything else — an unreachable gateway, an open circuit, a
   * 500 — is rethrown: swallowing those made every failure read as "not found", so `deletePolicy`
   * took its "nothing to delete" branch with Tyk down and `revoke()` went on to report the client
   * revoked while its policy was still live and its issued tokens still worked.
   */
  private async policyExists(policyId: string): Promise<boolean> {
    try {
      await this.request(`/policies/${encodeURIComponent(policyId)}`);
      return true;
    } catch (err) {
      if (err instanceof TykResponseError && err.upstreamStatus === 404) return false;
      throw err;
    }
  }

  /**
   * Block until the gateway reports the policy as loaded (`present: true`) or gone
   * (`present: false`), so a caller does not race the reload.
   *
   * The two directions do NOT have the same safety property, so they do not get the same
   * treatment. An unconfirmed LOAD only delays a new client — it is denied until the reload lands,
   * which is fail-closed on its own — so it stays a warning. An unconfirmed REMOVAL means tokens
   * mapped to this policy may still be accepted, so it throws: the caller
   * (`OAuthClientService.revoke`) must not delete the Hydra client and report success on top of a
   * revocation that never took effect.
   */
  private async waitForPolicy(policyId: string, present: boolean): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt < API_LOAD_ATTEMPTS; attempt++) {
      try {
        if ((await this.policyExists(policyId)) === present) return;
        lastError = undefined;
      } catch (err) {
        // Keep polling: the gateway may be mid-reload. The last failure is reported if we give up.
        lastError = err;
      }
      await sleep(API_LOAD_POLL_MS);
    }

    if (!present) {
      const cause = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new ServiceUnavailableException(
        `Gateway still serves policy ${policyId}; the revocation could not be confirmed${cause}`,
      );
    }

    this.logger.warn(`Gateway has not loaded policy ${policyId} yet; a later reload will apply it`);
  }

  /**
   * Probe `GET {TYK_GATEWAY_URL}/hello` (no auth) and time it. Never throws, and is deliberately
   * NOT circuit-broken: a health probe is exactly what must still run while the breaker is open.
   */
  async gatewayHealth(): Promise<TykGatewayHealth> {
    const unreachable = (error: string): TykGatewayHealth => ({
      reachable: false,
      status: null,
      version: null,
      redis: 'unknown',
      latencyMs: null,
      details: null,
      error,
    });

    if (!this.gatewayUrl) {
      return unreachable('Tyk gateway URL is not configured');
    }

    const startedAt = performance.now();
    try {
      const response = await fetch(`${this.gatewayUrl}/hello`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      const latencyMs = Math.round(performance.now() - startedAt);
      const body = (await response.json().catch(() => null)) as TykHelloBody | null;

      if (!body) {
        return unreachable(`Gateway returned an unreadable response (HTTP ${String(response.status)})`);
      }

      const redisStatus = body.details?.redis?.status;
      return {
        reachable: true,
        status: body.status ?? null,
        version: body.version ?? null,
        redis: redisStatus === 'pass' || redisStatus === 'fail' ? redisStatus : 'unknown',
        latencyMs,
        details: body.details ?? null,
        error: response.ok ? null : `Gateway reported HTTP ${String(response.status)}`,
      };
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      this.logger.warn(`Tyk gateway health probe failed: ${timedOut ? 'timeout' : 'unreachable'}`);
      return unreachable(timedOut ? 'Gateway health check timed out' : 'Gateway unreachable');
    }
  }

  /**
   * Tyk OSS only serves API definitions after a reload, and `/tyk/reload/group` merely SCHEDULES
   * one — so every mutation used to return while the gateway was still serving the old config.
   * Measured on v5.15.0: after `PUT /tyk/apis/<id>` + a group reload, `GET /tyk/apis/<id>` still
   * answered with the OLD `target_url` and only flipped ~1.5s later; a deleted API likewise kept
   * answering 200. That is what made `POST /apis/:id/sync` return before the new `jwt_source` was
   * live, and it is why the reads below are a real readiness signal: GET reflects the LOADED set,
   * not the files on disk.
   *
   * `?block=true` is honoured by the single-node endpoint only (measured: `/reload/` blocks 0.91s,
   * `/reload/group?block=true` returns in 0.00s), so both are called: the group call fans out to
   * any other node through Redis, the blocking call waits for THIS node — the one every read here
   * goes to — to finish serving the new config. Tyk batches reload requests into one cycle, so the
   * pair costs a single reload, not two.
   *
   * Non-fatal, as before: the definition is already stored, so a failed reload only delays routing.
   * Callers that must not proceed on an unconfirmed reload verify it themselves — see
   * `waitForPolicy`, which fails closed on a removal.
   */
  private async reloadGateway(): Promise<void> {
    await this.reloadNode(this.adminApiUrl);
  }

  /**
   * Reload ONE node and wait for it.
   *
   * `/reload/group` only *schedules* a reload over Redis pub/sub and `?block=true` is honoured
   * single-node only — measured here: `/reload/` blocks ~0.91 s, `/reload/group?block=true` returns
   * in 0.00 s. So a fan-out cannot rely on the group reload to have landed anywhere; each node gets
   * its own blocking reload instead.
   */
  private async reloadNode(nodeUrl: string): Promise<void> {
    await this.reload('/reload/?block=true', nodeUrl);
  }

  private async reload(path: string, nodeUrl: string = this.adminApiUrl): Promise<void> {
    try {
      const res = await fetch(`${nodeUrl}${path}`, {
        headers: { 'x-tyk-authorization': this.adminKey },
        signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(
          `Tyk gateway reload returned ${String(res.status)}; new API definitions may not be routed yet`,
        );
      }
    } catch {
      this.logger.warn('Tyk gateway reload failed; new API definitions may not be routed yet');
    }
  }

  /**
   * Sanitize Tyk response — strip internal IDs and sensitive data.
   * NEVER expose Tyk internals to the frontend.
   */
  sanitizeResponse(response: Record<string, unknown>): Record<string, unknown> {
    const sanitized = { ...response };

    // Remove Tyk internal fields
    delete sanitized.internal_id;
    delete sanitized.hook_references;
    delete sanitized.org_id;
    delete sanitized._id;

    return sanitized;
  }

  /**
   * Make authenticated request to Tyk Admin API.
   * NEVER logs or exposes the admin key.
   *
   * The network call is circuit-broken (not the domain-error handling below it): a Tyk-side 4xx/5xx
   * with a JSON body is a normal domain error, not an infra failure, so only a `fetch()` rejection
   * (connection refused, DNS, timeout) counts against the circuit. When the circuit is OPEN,
   * `circuitBreaker.execute` throws `CircuitBreakerOpenError` directly, which `ApiService.toSyncError`
   * maps to a generic "temporarily unavailable" message.
   */
  private async request<T extends object = TykStatusBody>(
    path: string,
    options: { method?: string; body?: string } = {},
    nodeUrl: string = this.adminApiUrl,
  ): Promise<T> {
    const url = `${nodeUrl}${path}`;

    // Per-node circuit: a dead node opens only its own breaker (WP13a).
    const result = await this.circuitBreaker.execute(`${CIRCUIT_NAME}:${nodeUrl}`, () =>
      fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'x-tyk-authorization': this.adminKey,
        },
        signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS),
      }),
    );
    if (!result.success) throw result.error;
    const response = result.data;

    const data = (await response.json().catch(() => ({}))) as TykStatusBody;

    if (!response.ok) {
      // Map Tyk error to domain error — NEVER expose Tyk internals
      const tykMessage = data.Message ?? data.message;
      const message = typeof tykMessage === 'string' ? tykMessage : 'Tyk API request failed';

      // A 404 is an expected answer on several paths — polling for a definition that has not loaded
      // yet, and confirming that a deleted policy is really gone — so it is not an error. Logging it
      // as one meant a clean revocation printed "Tyk API error: Policy not found" at ERROR.
      const log = response.status === 404 ? this.logger.debug.bind(this.logger) : this.logger.error.bind(this.logger);
      log(`Tyk API ${String(response.status)}: ${message}`);

      throw new TykResponseError(`Tyk integration error: ${message}`, response.status);
    }

    return this.sanitizeResponse(data as Record<string, unknown>) as T;
  }
}
