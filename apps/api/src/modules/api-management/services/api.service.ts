import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiKeyStatus,
  ApiStatus,
  ApiSyncStatus,
  Prisma,
  type ApiAuthType,
  type ApiDefinition,
  type ApiHealthStatus,
} from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { CreateApiDto } from '../dto/create-api.dto';
import { UpdateApiDto } from '../dto/update-api.dto';
import type { ApiConfig, ApiConfigDto } from '../dto/api-config.dto';
import { TykClientService } from '../../tyk-integration/services/tyk-client.service';
import { OAuthClientService } from '../../oauth-clients/services/oauth-client.service';
import { fetchAccessTokenSigningKey } from './hydra-signing-key';
import { CircuitBreakerOpenError } from '../../../common/circuit-breaker/circuit-breaker.types';
import { loadTenantScope, type TenantGatewayScope } from '../../tyk-integration/services/tenant-scope';

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
}

/** Response shape of every `/apis` route (spec §5.2). `keyCount` counts ACTIVE keys only. */
export interface ApiDetail {
  id: string;
  name: string;
  slug: string;
  proxyUrl: string;
  listenPath: string;
  authType: ApiAuthType;
  status: ApiStatus;
  tykApiId: string | null;
  syncStatus: ApiSyncStatus;
  syncError: string | null;
  lastSyncedAt: Date | null;
  healthStatus: ApiHealthStatus;
  config: ApiConfig;
  keyCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const SYNC_ERROR_MAX = 500;
const MAX_PAGE_SIZE = 100;

const withActiveKeyCount = {
  _count: { select: { apiKeys: { where: { status: ApiKeyStatus.ACTIVE } } } },
} satisfies Prisma.ApiDefinitionInclude;

type ApiRow = Prisma.ApiDefinitionGetPayload<{ include: typeof withActiveKeyCount }>;

/** `ApiDefinition.config` is free-form JSON in the schema; anything that is not an object reads as empty. */
function readConfig(value: Prisma.JsonValue | null): ApiConfig {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ApiConfig) : {};
}

/**
 * Tyk's JWT middleware fields for an `authType: OAUTH` API, i.e. one whose consumers authenticate
 * with a Hydra `client_credentials` access token.
 *
 * `jwtSource` is the base64 PEM of Hydra's access-token signing key (see `hydra-signing-key.ts` for
 * why it is pinned rather than pointed at a JWKS URL).
 *
 * That choice is now load-bearing for more than key rotation: it's WHY `tyk-gateway` can live on a
 * Docker network with no route to Hydra (see the network-split comment in infra/docker-compose.yml)
 * without breaking this data-plane auth. Tyk verifies every OAuth2 API's tokens from this embedded
 * PEM alone, zero Hydra calls. If `jwt_source` is ever switched to a live JWKS URL for non-breaking
 * rotation, every OAUTH-type API would need Hydra reachable from tyk-gateway again — reopening the
 * network hole that split was built to close, with a symptom (every such API 401ing) that points
 * nowhere near the network config. Don't make that switch without revisiting the split too.
 *
 * `jwt_policy_field_name: 'client_id'` is what maps a token to its Tyk policy: each OAuth2 client
 * gets a policy whose id IS its client id (see `oauth-clients/services/oauth-client-mapper.ts`), so
 * no Hydra token hook is needed, and a client only reaches the API its policy grants — the same
 * token answers 403 "key not authorized: no matching policy found" anywhere else. The claim has to
 * be a string: Tyk cannot resolve a policy from an array-valued claim. `jwt_default_policies` stays
 * empty on purpose, so a token with no matching policy is denied rather than defaulted.
 *
 * `use_oauth2` is NOT set: that switches on Tyk's own OAuth2 provider, which Hydra replaces.
 */
function jwtFieldsForOAuth(jwtSource: string): Record<string, unknown> {
  return {
    jwt_signing_method: 'rsa',
    jwt_source: jwtSource,
    jwt_identity_base_field: 'sub',
    jwt_policy_field_name: 'client_id',
    jwt_default_policies: [],
  };
}

/**
 * The Tyk policy id for an `authType: JWT` api's bring-your-own-JWKS policy (O3). Deterministic
 * (not a Hydra client id like OAuth's — there is no per-consumer client here), so `syncToTyk` can
 * compute it before the policy exists and reference it from `jwt_default_policies` on the very
 * first write.
 */
export const jwtPolicyId = (apiDefId: string): string => `og-jwt-${apiDefId}`;

/**
 * Tyk's JWT middleware fields for `authType: JWT` (O3, bring-your-own JWKS — the fix for the
 * `enable_jwt`-with-nothing-else bug this replaces, see the comment below).
 *
 * Unlike OAuth's per-Hydra-client policy, there is exactly one policy for every caller of this API:
 * `jwt_default_policies` (not `jwt_policy_field_name`) is set, so ANY token whose signature verifies
 * against `jwksUrl` is authorized identically — Tyk has no concept of "which external subject" here,
 * only "did this verify against the configured JWKS". A `jwt_policy_field_name` claim-to-policy
 * mapping would need a policy to already exist per claim value, which nothing here provisions.
 *
 * No explicit issuer check: Tyk classic API definitions have no `jwt_issuer`-style field (verified
 * against gateway/mw_jwt.go on the pinned v5.15.0 tag — the only issuer-aware code path is the OAS
 * multi-IdP "registry", which a classic definition never populates). "Wrong issuer" is still
 * rejected, because that token is signed by a key that is not IN `jwksUrl` — `issuer` is recorded on
 * the API for reference/audit only, not fed into the gateway.
 */
function jwtFieldsForBringYourOwnJwks(apiDefId: string, jwksUrl: string, identityField: string | undefined) {
  return {
    jwt_signing_method: 'rsa',
    jwt_source: jwksUrl,
    jwt_identity_base_field: identityField ?? 'sub',
    jwt_default_policies: [jwtPolicyId(apiDefId)],
  };
}

/**
 * What the gateway actually routes on: `/{tenantSlug}{listenPath}` (O10). `listenPath` always starts
 * with `/`, so a tenant's `/payments/` becomes `/acme/payments/` and a root `/` becomes `/acme/`.
 * Tenant slugs are globally unique, so two tenants' paths can never collide — which is what lets
 * `ApiDefinition.listenPath` be unique per tenant instead of globally.
 */
export const gatewayListenPath = (tenantSlug: string, listenPath: string): string =>
  `/${tenantSlug}${listenPath}`;

/**
 * The one policy every valid JWT for this API is mapped to (see `jwtFieldsForBringYourOwnJwks`).
 * Unlimited on top of whatever the API's own `global_rate_limit` already applies — the same
 * no-extra-limit baseline `buildTykPolicy` uses when an OAuth2 client sets none (`oauth-client-mapper.ts`).
 * Per-subject limits are a plans/policies feature (WP18), not this bug fix's job.
 */
export function buildJwtPolicy(
  apiDef: Pick<ApiDefinition, 'id' | 'name'>,
  tykApiId: string,
  tykOrgId: string,
): Record<string, unknown> {
  return {
    id: jwtPolicyId(apiDef.id),
    name: `${apiDef.name} — JWT`,
    org_id: tykOrgId,
    active: true,
    state: 'active',
    rate: 0,
    per: 0,
    quota_max: -1,
    access_rights: {
      [tykApiId]: { api_id: tykApiId, api_name: apiDef.name, versions: ['Default'] },
    },
  };
}

/** DTO instance -> plain JSON. Class fields are own `undefined` properties (ES2022 define semantics); dropping them keeps a merge from wiping stored values. */
function toJsonObject(config: ApiConfigDto): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(config)) as Prisma.InputJsonObject;
}

/**
 * Tyk definition for an API. Only `config`-driven keys are conditional; every other field is
 * unconditional. `jwtSource` (the base64 PEM from `fetchAccessTokenSigningKey`) is required for an
 * `authType: OAUTH` api and ignored for every other auth type.
 */
export function mapToTykFormat(
  apiDef: ApiDefinition,
  tenant: TenantGatewayScope,
  jwtSource = '',
): Record<string, unknown> {
  const { rateLimit, cors, doNotTrack, jwt } = readConfig(apiDef.config);

  return {
    name: apiDef.name,
    api_id: apiDef.tykApiId ?? `og-${apiDef.id}`,
    org_id: tenant.tykOrgId,
    proxy: {
      listen_path: gatewayListenPath(tenant.slug, apiDef.listenPath),
      target_url: apiDef.proxyUrl,
      strip_listen_path: true,
    },
    // Tyk rejects traffic with 403 "Version information not found" without version_data.
    version_data: { not_versioned: true, versions: { Default: { name: 'Default' } } },
    use_keyless: apiDef.authType === 'NONE',
    use_standard_auth: apiDef.authType === 'AUTH_TOKEN',
    // OAUTH = a Hydra-issued client_credentials JWT, verified against Hydra's signing key. JWT (O3) =
    // bring-your-own JWKS, verified against `config.jwt.jwksUrl` — `ApiService.create`/`update` refuse
    // to save `authType: JWT` with no `jwt` section, so `jwt` is never undefined here in practice; the
    // `enable_jwt` flag alone (ex-bug: no source, no policy, 100% rejected) is never emitted again.
    enable_jwt: apiDef.authType === 'JWT' || apiDef.authType === 'OAUTH',
    ...(apiDef.authType === 'OAUTH' ? jwtFieldsForOAuth(jwtSource) : {}),
    ...(apiDef.authType === 'JWT' && jwt
      ? jwtFieldsForBringYourOwnJwks(apiDef.id, jwt.jwksUrl, jwt.identityField)
      : {}),
    auth: { auth_header_name: 'Authorization' },
    active: apiDef.status === ApiStatus.ACTIVE,
    ...(rateLimit
      ? { global_rate_limit: { rate: rateLimit.rate, per: rateLimit.per, disabled: rateLimit.rate === 0 } }
      : {}),
    ...(cors
      ? {
          // Tyk's key really is upper-case `CORS`.
          CORS: {
            enable: cors.enable,
            allowed_origins: cors.allowedOrigins,
            allowed_methods: cors.allowedMethods,
            allowed_headers: cors.allowedHeaders,
            exposed_headers: cors.exposedHeaders,
            allow_credentials: cors.allowCredentials,
            max_age: cors.maxAge,
            options_passthrough: false,
            debug: false,
          },
        }
      : {}),
    ...(doNotTrack === undefined ? {} : { do_not_track: doNotTrack }),
  };
}

/**
 * Message stored in `syncError` and returned to the UI. `TykClientService` already turns gateway
 * error bodies into sanitised `HttpException`s; anything else (fetch/network errors) may carry
 * hostnames or ports, so it collapses to a fixed string.
 */
export function toSyncError(err: unknown): string {
  let message = 'Gateway unreachable';
  if (err instanceof HttpException) {
    message = err.message;
  } else if (err instanceof CircuitBreakerOpenError) {
    message = 'Gateway temporarily unavailable, retry shortly';
  }
  return message.slice(0, SYNC_ERROR_MAX);
}

/**
 * Listen paths are unique **within a tenant** (O10): the gateway sees `/{tenantSlug}{listenPath}`,
 * so another tenant holding the same path is not a clash and must not be reported as one. The
 * message can therefore name the path — it can only ever be this tenant's own.
 * Prefix overlaps (`/a/` next to `/a/b/`) are allowed: Tyk routes by longest match.
 */
const listenPathTaken = (listenPath: string): string =>
  `Listen path "${listenPath}" is already used by another API in this tenant.`;

const slugTaken = (slug: string): string => `API with slug "${slug}" already exists in this tenant`;

/**
 * A unique violation that slipped past the pre-checks (two concurrent requests) still has to answer
 * 409, not 500. Anything else is returned unchanged for the caller to rethrow.
 */
function asConflict(err: unknown, slug: string | undefined, listenPath: string | undefined): unknown {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return err;
  }
  // `meta.target` is free-form JSON (a string or a list of columns, depending on the driver).
  const fields = JSON.stringify(err.meta?.target ?? '');

  return fields.includes('listen_path')
    ? new ConflictException(listenPathTaken(listenPath ?? ''))
    : new ConflictException(slugTaken(slug ?? ''));
}

function toApiDetail(row: ApiRow): ApiDetail {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    proxyUrl: row.proxyUrl,
    listenPath: row.listenPath,
    authType: row.authType,
    status: row.status,
    tykApiId: row.tykApiId,
    syncStatus: row.syncStatus,
    syncError: row.syncError,
    lastSyncedAt: row.lastSyncedAt,
    healthStatus: row.healthStatus,
    config: readConfig(row.config),
    keyCount: row._count.apiKeys,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class ApiService {
  private readonly logger = new Logger(ApiService.name);

  constructor(
    private readonly tykClient: TykClientService,
    private readonly oauthClients: OAuthClientService,
  ) {}

  async create(dto: CreateApiDto, tenantId: string): Promise<ApiDetail> {
    // Check slug uniqueness within tenant
    const existing = await prisma.apiDefinition.findUnique({
      where: { tenantId_slug: { tenantId, slug: dto.slug } },
    });

    if (existing) {
      throw new ConflictException(slugTaken(dto.slug));
    }

    // O3: an unconditional `enable_jwt` with no source/policy is the bug this DTO section fixes —
    // never let that combination reach the gateway again.
    if (dto.authType === 'JWT' && !dto.config?.jwt) {
      throw new BadRequestException('authType "JWT" requires config.jwt: { jwksUrl, issuer }');
    }

    await this.assertListenPathFree(dto.listenPath, tenantId);

    // Create in our database
    let apiDef: ApiRow;
    try {
      apiDef = await prisma.apiDefinition.create({
        data: {
          tenantId,
          name: dto.name,
          slug: dto.slug,
          proxyUrl: dto.proxyUrl,
          listenPath: dto.listenPath,
          authType: dto.authType,
          config: dto.config ? toJsonObject(dto.config) : {},
          status: ApiStatus.DRAFT,
          syncStatus: ApiSyncStatus.PENDING,
        },
        include: withActiveKeyCount,
      });
    } catch (err) {
      throw asConflict(err, dto.slug, dto.listenPath);
    }

    // Sync to Tyk (fire and forget — background sync)
    this.syncInBackground(apiDef);

    return toApiDetail(apiDef);
  }

  async findAll(
    tenantId: string,
    page = 1,
    pageSize = 20,
    status?: ApiStatus,
    syncStatus?: ApiSyncStatus,
    q?: string,
  ): Promise<PaginatedResult<ApiDetail>> {
    const safePage = Math.max(1, page);
    const take = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);
    const where: Prisma.ApiDefinitionWhereInput = { tenantId };

    if (status) {
      where.status = status;
    }
    if (syncStatus) {
      where.syncStatus = syncStatus;
    }
    const term = q?.trim();
    if (term) {
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { slug: { contains: term, mode: 'insensitive' } },
        { listenPath: { contains: term, mode: 'insensitive' } },
      ];
    }

    const [rows, totalCount] = await Promise.all([
      prisma.apiDefinition.findMany({
        where,
        skip: (safePage - 1) * take,
        take,
        orderBy: { createdAt: 'desc' },
        include: withActiveKeyCount,
      }),
      prisma.apiDefinition.count({ where }),
    ]);

    return {
      data: rows.map(toApiDetail),
      meta: {
        page: safePage,
        pageSize: take,
        totalCount,
        totalPages: Math.ceil(totalCount / take),
      },
    };
  }

  async findOne(id: string, tenantId: string): Promise<ApiDetail> {
    return toApiDetail(await this.findRow(id, tenantId));
  }

  async update(id: string, dto: UpdateApiDto, tenantId: string): Promise<ApiDetail> {
    const existing = await this.findRow(id, tenantId);

    // If slug is changing, check uniqueness
    if (dto.slug && dto.slug !== existing.slug) {
      const duplicate = await prisma.apiDefinition.findUnique({
        where: { tenantId_slug: { tenantId, slug: dto.slug } },
      });
      if (duplicate) {
        throw new ConflictException(slugTaken(dto.slug));
      }
    }

    if (dto.listenPath && dto.listenPath !== existing.listenPath) {
      await this.assertListenPathFree(dto.listenPath, tenantId);
    }

    const { config, ...fields } = dto;
    // The change is not on the gateway yet: don't keep reporting the previous SYNCED state.
    const data: Prisma.ApiDefinitionUpdateInput = { ...fields, syncStatus: ApiSyncStatus.PENDING };
    if (config) {
      // Section-level merge: an absent section keeps its stored value, `null` clears it.
      data.config = { ...readConfig(existing.config), ...toJsonObject(config) } as Prisma.InputJsonObject;
    }

    // O3, same guard as `create`: the effective authType after this PATCH — whether just set now or
    // already JWT and merely untouched here — must carry a jwt section, using the SAME merged config
    // `data.config` above just computed (so a PATCH that clears `jwt` while leaving authType: JWT is
    // caught too, not just a bare authType switch with no config at all).
    const effectiveAuthType = dto.authType ?? existing.authType;
    const effectiveConfig = config ? (data.config as Prisma.JsonValue) : existing.config;
    if (effectiveAuthType === 'JWT' && !readConfig(effectiveConfig).jwt) {
      throw new BadRequestException('authType "JWT" requires config.jwt: { jwksUrl, issuer }');
    }

    let updated: ApiRow;
    try {
      updated = await prisma.apiDefinition.update({
        where: { id },
        data,
        include: withActiveKeyCount,
      });
    } catch (err) {
      throw asConflict(err, dto.slug, dto.listenPath);
    }

    // Sync changes to Tyk
    this.syncInBackground(updated);

    return toApiDetail(updated);
  }

  /** Hard delete (D16): refused while ACTIVE keys reference the API; removes the gateway definition first. */
  async remove(id: string, tenantId: string): Promise<{ message: string }> {
    const apiDef = await this.findRow(id, tenantId);

    if (apiDef._count.apiKeys > 0) {
      throw new ConflictException(
        `Cannot delete API: ${String(apiDef._count.apiKeys)} active key(s) still use it. Revoke them first.`,
      );
    }

    // OAuth2 clients live in Hydra, not in `apiKeys`, so the count above cannot see them. Always
    // check — not just when authType is currently OAUTH — because authType is patchable (UpdateApiDto
    // extends PartialType(CreateApiDto)): flipping it away from OAUTH first would otherwise let this
    // check skip past clients Hydra still holds, stranding credentials the dashboard can no longer
    // list or revoke (findByApi filters by apiDefId, independent of the API's current authType).
    const clients = await this.oauthClients.findByApi(id, tenantId);
    if (clients.length > 0) {
      throw new ConflictException(
        `Cannot delete API: ${String(clients.length)} OAuth2 client(s) still use it. Revoke them first.`,
      );
    }

    if (apiDef.tykApiId) {
      try {
        await this.tykClient.deleteApi(apiDef.tykApiId);
      } catch (err) {
        // Keep the row: deleting it while the definition stays live would orphan a routable API.
        throw new BadGatewayException(`Could not remove the API from the gateway: ${toSyncError(err)}`);
      }
    }

    // Best-effort: the API is already gone from the gateway at this point, so a leftover policy
    // file is a paper cut (`deletePolicy` is idempotent), never a reason to fail the delete.
    if (apiDef.authType === 'JWT') {
      try {
        await this.tykClient.deletePolicy(jwtPolicyId(apiDef.id));
      } catch (err) {
        this.logger.warn(
          `Could not remove JWT policy for deleted API ${apiDef.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await prisma.apiDefinition.delete({ where: { id } });

    return { message: 'API deleted' };
  }

  /**
   * Awaited sync for `POST /apis/:id/sync`. Never rejects because of the gateway: a failed sync
   * comes back as `syncStatus: 'FAILED'` + `syncError` on the returned record.
   */
  async syncNow(id: string, tenantId: string): Promise<ApiDetail> {
    const apiDef = await this.findRow(id, tenantId);
    return toApiDetail(await this.syncToTyk(apiDef));
  }

  /**
   * Refuse a listen path another API **in this tenant** already owns (O10). Another tenant holding
   * the same path is fine: the gateway routes on `/{tenantSlug}{listenPath}`, so the two cannot
   * collide. The exact stored string is compared — the DTO already enforces the leading slash.
   */
  private async assertListenPathFree(listenPath: string, tenantId: string): Promise<void> {
    const clash = await prisma.apiDefinition.findFirst({
      where: { listenPath, tenantId },
      select: { id: true },
    });

    if (clash) {
      throw new ConflictException(listenPathTaken(listenPath));
    }
  }

  private async findRow(id: string, tenantId: string): Promise<ApiRow> {
    const apiDef = await prisma.apiDefinition.findFirst({
      where: { id, tenantId },
      include: withActiveKeyCount,
    });

    if (!apiDef) {
      throw new NotFoundException('API definition not found');
    }

    return apiDef;
  }

  private syncInBackground(apiDef: ApiDefinition): void {
    // syncToTyk only rejects on a database failure; gateway failures are recorded on the row.
    this.syncToTyk(apiDef).catch((err: unknown) => {
      this.logger.error(
        `Failed to record sync of API ${apiDef.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * The signing key an OAUTH api pins, re-read on every sync so `POST /apis/:id/sync` is the
   * operator's way to pick up a rotated Hydra key. A failure is a gateway error, so it lands on the
   * row as `syncStatus: FAILED` with a message that says what actually went wrong.
   */
  private async oauthSigningKey(authType: ApiAuthType): Promise<string> {
    if (authType !== 'OAUTH') return '';

    try {
      return await fetchAccessTokenSigningKey(process.env.ORY_HYDRA_ADMIN_URL ?? 'http://hydra:4445');
    } catch (err) {
      throw new BadGatewayException(
        err instanceof Error ? err.message : 'Could not read the OAuth2 signing key',
      );
    }
  }

  /** Push the definition to Tyk and persist the outcome: SYNCED + `lastSyncedAt`, or FAILED + `syncError`. */
  private async syncToTyk(apiDef: ApiDefinition): Promise<ApiRow> {
    let tykApiId: string;

    // Read once here rather than threading a tenant through every caller: the org and slug must be
    // identical across the definition and its JWT policy, and one query per sync is cheaper than the
    // chance of two call sites drifting apart. `tenantId` is a non-null FK, so this always resolves.
    const tenant = await loadTenantScope(apiDef.tenantId);

    try {
      const tykDef = mapToTykFormat(apiDef, tenant, await this.oauthSigningKey(apiDef.authType));

      if (apiDef.tykApiId) {
        // Update existing
        await this.tykClient.updateApi(apiDef.tykApiId, tykDef);
        tykApiId = apiDef.tykApiId;
      } else {
        // Create new
        tykApiId = (await this.tykClient.createApi(tykDef)).apiId;
      }

      // The def above already points jwt_default_policies at jwtPolicyId(apiDef.id) — that policy
      // itself only becomes resolvable once it exists, and it needs tykApiId (just learned) for its
      // access_rights, so it is written second. Same try/catch as the def write: a policy failure is
      // a sync failure, not a silently-half-authorized API.
      if (apiDef.authType === 'JWT') {
        await this.tykClient.upsertPolicy(buildJwtPolicy(apiDef, tykApiId, tenant.tykOrgId));
      }
    } catch (err) {
      const syncError = toSyncError(err);
      this.logger.warn(`Sync of API ${apiDef.id} failed: ${syncError}`);

      return prisma.apiDefinition.update({
        where: { id: apiDef.id },
        data: { syncStatus: ApiSyncStatus.FAILED, syncError },
        include: withActiveKeyCount,
      });
    }

    return prisma.apiDefinition.update({
      where: { id: apiDef.id },
      data: {
        tykApiId,
        syncStatus: ApiSyncStatus.SYNCED,
        syncError: null,
        lastSyncedAt: new Date(),
        healthStatus: 'UNKNOWN' as const,
      },
      include: withActiveKeyCount,
    });
  }
}
