import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiDefFormat,
  ApiKeyStatus,
  ApiProtocol,
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
import { CreateApiVersionDto } from '../dto/create-api-version.dto';
import type { ApiConfig, ApiConfigDto } from '../dto/api-config.dto';
import { TykClientService } from '../../tyk-integration/services/tyk-client.service';
import { OAuthClientService } from '../../oauth-clients/services/oauth-client.service';
import { fetchAccessTokenSigningKey } from './hydra-signing-key';
import { CircuitBreakerOpenError } from '../../../common/circuit-breaker/circuit-breaker.types';
import { loadTenantScope } from '../../tyk-integration/services/tenant-scope';
import { isCertOwnedByOrg } from '../../certificates/services/certificate.service';
import {
  buildJwtPolicy,
  jwtPolicyId,
  mapToTykFormat,
  mapToTykOas,
  readConfig,
  type ApiVersionChild,
} from './tyk-mappers';
import { redactRelaySecret } from '../../webhooks/webhook-relay.constants';
import type { NodeOutcome, TykDebugResult } from '../../tyk-integration/services/tyk-client.service';
import type { DebugRequestDto } from '../dto/debug-request.dto';
import { ReconcileService, type SyncState } from './reconcile.service';
import { MAX_MANAGED_ENDPOINTS, readGovernanceState } from './endpoint-governance';
import { EndpointRenderError, hasRealOperations, readBackMismatches, type EndpointRef } from './endpoint-operations';

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
  /**
   * The generated Tyk OAS document (WP17 Designer): `mapToTykOas` output, regenerated and
   * overwritten on every sync tick — NOT an imported spec's original shape (that's `sourceOasDocument`,
   * unbuilt — see the WP17 plan note). `paths` is empty unless per-operation middleware (circuit
   * breaker, URL rewrite, mock, body transform, schema validation) is configured, in which case it
   * holds one synthesised catch-all path (`/.*`) per method — this product proxies whole upstreams
   * rather than describing per-endpoint contracts, so that's genuinely everything there is to list
   * until OAS import (WP24) lands. `null` for a CLASSIC-format API.
   */
  oasDocument: Prisma.JsonValue | null;
  keyCount: number;
  /** WP16: null on a plain API and on a family's default; set on a child, pointing at its default. */
  parentApiId: string | null;
  /** WP16: this row's own version name, or null if it has never been part of a version family. */
  versionName: string | null;
  /** WP16: when this (non-default) version was retired. `GET /apis/:id` answers 410 + `Sunset` once set. */
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** WP27. HTTP for the overwhelming majority of APIs; TCP is forced CLASSIC at creation. */
  protocol: ApiProtocol;
  /** WP27: only meaningful when `protocol` is TCP. */
  listenPort: number | null;
  /** WP27: true once this API has at least one active WebhookSubscription. */
  webhooksEnabled: boolean;
  /** Which mapper produced this API's gateway definition — exposed so a client can tell why, e.g., `protocol: TCP` is refused. */
  defFormat: ApiDefFormat;
}

/**
 * A retired API version (WP16): deliberately, permanently gone — 410, not 404 — with an RFC 8594
 * `Sunset` header carrying when. `AllExceptionsFilter` adds that header itself, duck-typed off
 * `sunsetAt` alone (common/ shouldn't import a feature module's exception class).
 *
 * Not Tyk's own `info.expiration`: live-verified against v5.15.0 that an expired version answers
 * 403 "API has expired, please check documentation or contact administrator" with no `Sunset`
 * header at all — not this product's contract. This is purely our management API's own answer to
 * `GET /apis/:id` on a retired row; the gateway's data-plane behaviour for a retired version is
 * separate (its sibling entry drops out of `info.versioning` on the next sync — see `mapToTykOas`).
 */
export class RetiredVersionException extends GoneException {
  constructor(
    readonly sunsetAt: Date,
    name: string,
  ) {
    super(`API version "${name}" was retired and is no longer available.`);
  }
}

const SYNC_ERROR_MAX = 500;
const MAX_PAGE_SIZE = 100;

const withActiveKeyCount = {
  _count: { select: { apiKeys: { where: { status: ApiKeyStatus.ACTIVE } } } },
} satisfies Prisma.ApiDefinitionInclude;

type ApiRow = Prisma.ApiDefinitionGetPayload<{ include: typeof withActiveKeyCount }>;






/**
 * A version row's own `listenPath` (WP16). Never routed to directly: traffic reaches a version only
 * through the DEFAULT's listen path plus the `x-api-version` header (see `mapToTykOas`'s
 * `info.versioning`). It exists purely because every Tyk OAS definition — including a version's, its
 * own full definition — needs a `server.listenPath.value`, and `api_definitions` needs it unique
 * within the tenant (`@@unique([tenantId, listenPath])`).
 */
const versionListenPath = (parentListenPath: string, versionName: string): string =>
  `${parentListenPath.replace(/\/$/, '')}/__version-${versionName}`;

/** This family's own name for the default/base version, applied the moment its first child is created. */
export const DEFAULT_VERSION_NAME = 'v1';



/** A `config` filter matching exactly the value that was read (jsonb equality; NULL via AnyNull). */
const configIs = (value: Prisma.JsonValue | null): Prisma.JsonNullableFilter<'ApiDefinition'> =>
  value === null ? { equals: Prisma.AnyNull } : { equals: value as Prisma.InputJsonValue };

/** DTO instance -> plain JSON. Class fields are own `undefined` properties (ES2022 define semantics); dropping them keeps a merge from wiping stored values. */
function toJsonObject(config: ApiConfigDto): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(config)) as Prisma.InputJsonObject;
}








/**
 * Shape `POST /tyk/debug` wants for the sample request itself. Tyk decodes `headers` as Go's
 * `http.Header` (name -> string[]); a plain string value fails the decode ("Request malformed").
 */
function buildDebugRequest(dto: DebugRequestDto): Record<string, unknown> {
  return {
    method: dto.method,
    path: dto.path,
    ...(dto.headers
      ? {
          headers: Object.fromEntries(
            Object.entries(dto.headers).map(([name, value]) => [name, [value]]),
          ),
        }
      : {}),
    ...(dto.body === undefined ? {} : { body: dto.body }),
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
  } else if (err instanceof EndpointRenderError) {
    // Our own refusal to render (e.g. two endpoints that route the same): no host or port in it.
    message = err.message;
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

/**
 * OAS-03: an API-wide cache and a per-endpoint cache would fight over `middleware.global.cache`; the
 * endpoint write path refuses the one, `update()` refuses the other.
 */
function assertNoCacheConflict(config: ApiConfigDto | undefined, stored: Prisma.JsonValue | null): void {
  if (config?.cache && Object.values(readGovernanceState(readConfig(stored)).endpoints).some((g) => g.cache)) {
    throw new BadRequestException('An API-wide cache is refused while endpoints have their own cache; clear those first.');
  }
}

/** A `GET /apis` row: OAS-08 adds whether a watched spec URL proposes a new version. */
export type ApiListItem = ApiDetail & { specUpdateAvailable: boolean };

/**
 * OAS-08: the PENDING spec candidates worth showing — only those whose content still differs from the
 * API's latest stored version (a manual upload of the same bytes makes a candidate moot without
 * touching its row). One query for any number of APIs, newest first, at most 100.
 */
export async function pendingSpecCandidates(
  tenantId: string,
  apiDefIds?: readonly string[],
): Promise<{ id: string; apiDefId: string }[]> {
  if (apiDefIds?.length === 0) return [];
  return prisma.$queryRaw<{ id: string; apiDefId: string }[]>(Prisma.sql`
    SELECT c.id, c.api_def_id AS "apiDefId"
    FROM spec_candidates c
    WHERE c.tenant_id = ${tenantId}
      AND c.state = 'PENDING'
      ${apiDefIds ? Prisma.sql`AND c.api_def_id IN (${Prisma.join(apiDefIds)})` : Prisma.empty}
      AND c.content_hash IS DISTINCT FROM (
        SELECT s.content_hash FROM api_specs s
        WHERE s.api_def_id = c.api_def_id AND s.tenant_id = c.tenant_id
        ORDER BY s.version_no DESC LIMIT 1
      )
    ORDER BY c.detected_at DESC
    LIMIT 100`);
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
    // The stored document carries the webhook relay secret; the copy sent to clients does not.
    oasDocument: redactRelaySecret(row.oasDocument),
    keyCount: row._count.apiKeys,
    parentApiId: row.parentApiId,
    versionName: row.versionName,
    retiredAt: row.retiredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    protocol: row.protocol,
    listenPort: row.listenPort,
    webhooksEnabled: row.webhooksEnabled,
    defFormat: row.defFormat,
  };
}

/** The first stored version of the OpenAPI document an API was imported from (OAS-01). */
export interface NewApiSpec {
  contentHash: string;
  format: string;
  openapiVersion: string;
  sourceText: string;
  endpointIndex: Prisma.InputJsonValue;
  endpointCount: number;
}

@Injectable()
export class ApiService {
  private readonly logger = new Logger(ApiService.name);

  /**
   * M3: the tail of each API's sync chain. Syncs of ONE API run one after another, each re-reading the row
   * inside the chain, so two quick PATCHes can never leave the gateway on the older config while the row
   * says SYNCED. ponytail: per PROCESS — two API replicas can still interleave; a DB advisory lock or an
   * outbox worker is the upgrade when the API runs more than one replica.
   */
  private readonly syncChains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly tykClient: TykClientService,
    private readonly oauthClients: OAuthClientService,
    private readonly reconcile: ReconcileService,
  ) {}

  /**
   * `spec` (OAS-01) is the OpenAPI document an import came from. When present, the API row and its
   * first `api_specs` row are written in ONE short DB transaction — never a state where the API
   * exists but its spec was lost. No gateway call happens inside it (that stays in the background sync).
   */
  async create(dto: CreateApiDto, tenantId: string, spec?: NewApiSpec): Promise<ApiDetail> {
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

    // WP26a: a cert id is a bare string Tyk does not scope by org at USE time (only listing does,
    // live-verified) — without this, tenant A could reference tenant B's uploaded certificate, and
    // therefore push traffic under B's private key, just by knowing or guessing its id.
    if (dto.config?.upstreamMutualTls) {
      const { tykOrgId } = await loadTenantScope(tenantId);
      if (!isCertOwnedByOrg(dto.config.upstreamMutualTls.certificateId, tykOrgId)) {
        throw new BadRequestException(
          `Certificate ${dto.config.upstreamMutualTls.certificateId} not found in this tenant`,
        );
      }
    }

    await this.assertListenPathFree(dto.listenPath, tenantId);

    // Create in our database
    let apiDef: ApiRow;
    const data = {
      tenantId,
      name: dto.name,
      slug: dto.slug,
      proxyUrl: dto.proxyUrl,
      listenPath: dto.listenPath,
      authType: dto.authType,
      config: dto.config ? toJsonObject(dto.config) : {},
      status: ApiStatus.DRAFT,
      syncStatus: ApiSyncStatus.PENDING,
      protocol: dto.protocol ?? ApiProtocol.HTTP,
      listenPort: dto.protocol === ApiProtocol.TCP ? dto.listenPort : null,
      // WP27: OAS has no TCP fields at all, so a TCP api is forced CLASSIC here rather than left
      // to default OAS and fail confusingly on its first sync.
      ...(dto.protocol === ApiProtocol.TCP ? { defFormat: ApiDefFormat.CLASSIC } : {}),
    } satisfies Prisma.ApiDefinitionUncheckedCreateInput;
    try {
      apiDef =
        spec === undefined
          ? await prisma.apiDefinition.create({ data, include: withActiveKeyCount })
          : await prisma.$transaction(async (tx) => {
              const created = await tx.apiDefinition.create({ data, include: withActiveKeyCount });
              await tx.apiSpec.create({ data: { tenantId, apiDefId: created.id, versionNo: 1, ...spec } });
              return created;
            });
    } catch (err) {
      throw asConflict(err, dto.slug, dto.listenPath);
    }

    // Sync to Tyk (fire and forget — background sync)
    this.syncInBackground(apiDef);

    return toApiDetail(apiDef);
  }

  /**
   * `POST /apis/:id/versions` (WP16): a genuinely separate OAS definition — its own `proxyUrl`,
   * auth, config — selected by clients sending `x-api-version: <versionName>` to the DEFAULT's
   * listen path. `slug` and `listenPath` are derived rather than user-supplied: nothing routes to
   * a version's own listen path directly (`versionListenPath`), so asking a caller to invent one
   * would only invite a value nobody ever uses.
   *
   * Awaits the child's own sync before returning: the default's next sync needs the child's
   * `tykApiId` to put in `info.versioning.versions`, so the child has to exist on the gateway first.
   */
  async createVersion(id: string, dto: CreateApiVersionDto, tenantId: string): Promise<ApiDetail> {
    const parent = await this.findRow(id, tenantId);

    if (parent.parentApiId !== null) {
      throw new BadRequestException('Cannot create a version of a version; create it on the default API.');
    }
    if (parent.defFormat !== ApiDefFormat.OAS) {
      throw new BadRequestException(
        'API versioning requires an API defined from an OpenAPI document; this API uses a classic definition.',
      );
    }
    // O3, same guard as `create`/`update`.
    if (dto.authType === 'JWT' && !dto.config?.jwt) {
      throw new BadRequestException('authType "JWT" requires config.jwt: { jwksUrl, issuer }');
    }

    const childListenPath = versionListenPath(parent.listenPath, dto.versionName);
    const childSlug = `${parent.slug}-${dto.versionName}`;

    let child: ApiRow;
    try {
      child = await prisma.apiDefinition.create({
        data: {
          tenantId,
          parentApiId: parent.id,
          versionName: dto.versionName,
          name: `${parent.name} (${dto.versionName})`,
          slug: childSlug,
          proxyUrl: dto.proxyUrl,
          listenPath: childListenPath,
          authType: dto.authType ?? parent.authType,
          config: dto.config ? toJsonObject(dto.config) : {},
          status: ApiStatus.ACTIVE,
          defFormat: ApiDefFormat.OAS,
          syncStatus: ApiSyncStatus.PENDING,
        },
        include: withActiveKeyCount,
      });
    } catch (err) {
      // A duplicate `versionName` always produces a duplicate derived slug too (childSlug encodes
      // it), so asConflict's slug-vs-listen-path split already lands on the right message.
      throw asConflict(err, childSlug, childListenPath);
    }

    // The family's own version name is assigned once, on its first child — an API that never gains
    // one keeps it null forever and mapToTykOas keeps omitting `info.versioning` for it.
    if (parent.versionName === null) {
      await prisma.apiDefinition.update({
        where: { id: parent.id },
        data: { versionName: DEFAULT_VERSION_NAME },
      });
    }

    await this.syncToTyk(child);
    await this.resyncParent(parent.id);

    return toApiDetail(await this.findRow(child.id, tenantId));
  }

  async findAll(
    tenantId: string,
    page = 1,
    pageSize = 20,
    status?: ApiStatus,
    syncStatus?: ApiSyncStatus,
    q?: string,
  ): Promise<PaginatedResult<ApiListItem>> {
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

    const pending = new Set((await pendingSpecCandidates(tenantId, rows.map((row) => row.id))).map((c) => c.apiDefId));
    return {
      data: rows.map((row) => ({ ...toApiDetail(row), specUpdateAvailable: pending.has(row.id) })),
      meta: {
        page: safePage,
        pageSize: take,
        totalCount,
        totalPages: Math.ceil(totalCount / take),
      },
    };
  }

  async findOne(id: string, tenantId: string): Promise<ApiDetail> {
    const row = await this.findRow(id, tenantId);
    // WP16: `update()` always stamps `retiredAt` in the same write that sets RETIRED, so it is
    // never null here in practice — the check just satisfies the type rather than trusting that blind.
    if (row.status === ApiStatus.RETIRED && row.retiredAt) {
      throw new RetiredVersionException(row.retiredAt, row.name);
    }
    return toApiDetail(row);
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

    assertNoCacheConflict(config, existing.config);

    // OAS-03: governance needs an HTTP API; a protocol switch would render (or refuse) it silently.
    const governance = readGovernanceState(readConfig(existing.config));
    if (
      dto.protocol !== undefined &&
      dto.protocol !== existing.protocol &&
      (governance.restrictToSpec || Object.keys(governance.endpoints).length > 0)
    ) {
      throw new BadRequestException('The protocol of an API that governs endpoints cannot change; clear its endpoint governance first.');
    }

    // WP26a, same rule as `create`: check the EFFECTIVE (merged) config so a PATCH that leaves
    // `upstreamMutualTls` untouched from an earlier, still-valid write is not re-validated away,
    // while a PATCH that sets or changes it is.
    const effectiveUpstreamMutualTls = readConfig(effectiveConfig).upstreamMutualTls;
    if (effectiveUpstreamMutualTls) {
      const { tykOrgId } = await loadTenantScope(tenantId);
      if (!isCertOwnedByOrg(effectiveUpstreamMutualTls.certificateId, tykOrgId)) {
        throw new BadRequestException(
          `Certificate ${effectiveUpstreamMutualTls.certificateId} not found in this tenant`,
        );
      }
    }

    // WP16: RETIRED is a version-lifecycle state, not a generic one — retiring the default would
    // leave the family's `x-api-version` routing (and every key still pointed at it) with nothing
    // to serve, so only a child can take it. `retiredAt` is this row's Sunset-header timestamp
    // (GET /apis/:id, ApiManagementController.findOne) and is cleared on any move away from RETIRED.
    if (dto.status === ApiStatus.RETIRED) {
      if (existing.parentApiId === null) {
        throw new BadRequestException(
          'Only a non-default version can be retired. Disable or delete the default API instead.',
        );
      }
      data.retiredAt = new Date();
    } else if (dto.status !== undefined && existing.status === ApiStatus.RETIRED) {
      data.retiredAt = null;
    }

    let updated: ApiRow;
    try {
      updated = config
        ? await this.writeConfigGuarded(id, tenantId, existing.config, data, config)
        : await prisma.apiDefinition.update({ where: { id }, data, include: withActiveKeyCount });
    } catch (err) {
      throw asConflict(err, dto.slug, dto.listenPath);
    }

    // Sync changes to Tyk
    this.syncInBackground(updated);

    // WP16: a retire/un-retire also changes what the DEFAULT should be serving — it must drop or
    // re-add this child in `info.versioning.versions` on its own next sync.
    if (existing.parentApiId && dto.status !== undefined) {
      await this.resyncParent(existing.parentApiId);
    }

    return toApiDetail(updated);
  }

  /**
   * `update()` with a `config` section: the merged config is written ONLY if the stored config is still
   * the one it was merged from, so a concurrent `PATCH /apis/:id/endpoints` (which writes the same JSON
   * column) is never silently overwritten. On a lost race: re-read, re-merge the same sections, retry
   * once; then 409. The other checks in `update()` ran against the first read — only governance keys
   * can differ in between unless two config PATCHes race, and the retry then re-applies this one's sections.
   */
  private async writeConfigGuarded(
    id: string,
    tenantId: string,
    readConfigValue: Prisma.JsonValue | null,
    data: Prisma.ApiDefinitionUpdateInput,
    config: ApiConfigDto,
  ): Promise<ApiRow> {
    let base = readConfigValue;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        base = (await this.findRow(id, tenantId)).config;
        assertNoCacheConflict(config, base);
      }
      const merged = { ...readConfig(base), ...toJsonObject(config) } as Prisma.InputJsonObject;
      const { count } = await prisma.apiDefinition.updateMany({
        where: { id, tenantId, config: configIs(base) },
        // `data` holds only scalar columns (DTO fields, syncStatus, retiredAt), which updateMany accepts.
        data: { ...(data as Prisma.ApiDefinitionUpdateManyMutationInput), config: merged },
      });
      if (count === 1) return this.findRow(id, tenantId);
    }
    throw new ConflictException({
      message: 'The API configuration changed while it was being saved; reload and retry',
      error: 'API_CONFIG_CHANGED',
    });
  }

  /** Hard delete (D16): refused while ACTIVE keys reference the API; removes the gateway definition first. */
  async remove(id: string, tenantId: string): Promise<{ message: string }> {
    const apiDef = await this.findRow(id, tenantId);

    // WP16: the default's `info.versioning` config is what routes every version, and every version
    // row FK-references it (`onDelete: Restrict`, so the database would refuse this anyway) — refuse
    // it here first, with a message that says why, rather than surfacing a raw FK-violation 500.
    if (apiDef.parentApiId === null) {
      const versionCount = await prisma.apiDefinition.count({ where: { parentApiId: apiDef.id } });
      if (versionCount > 0) {
        throw new ConflictException(
          `Cannot delete the default version: ${String(versionCount)} version(s) still exist. Delete or retire them first.`,
        );
      }
    }

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

    // WP16: a deleted child must disappear from the default's `info.versioning.versions` too.
    if (apiDef.parentApiId) {
      await this.resyncParent(apiDef.parentApiId);
    }

    return { message: 'API deleted' };
  }

  /**
   * OAS-03: write `next` as the API's whole `config` ONLY if it still equals `expected` (the value the
   * caller read), in one statement — never a read-then-write. Marks the row PENDING and starts the normal
   * background sync. `false` means someone else changed `config` first (the caller answers 409).
   */
  async compareAndSetConfig(
    id: string,
    tenantId: string,
    expected: Prisma.JsonValue | null,
    next: Prisma.InputJsonObject,
  ): Promise<boolean> {
    const { count } = await prisma.apiDefinition.updateMany({
      where: {
        id,
        tenantId,
        config: configIs(expected),
      },
      data: { config: next, syncStatus: ApiSyncStatus.PENDING },
    });
    if (count === 0) return false;
    this.syncInBackground(await this.findRow(id, tenantId));
    return true;
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

  /** Re-push a family's default after one of its versions changed (WP16), fire-and-forget like every other sync. */
  private async resyncParent(parentApiId: string): Promise<void> {
    const parent = await prisma.apiDefinition.findUnique({ where: { id: parentApiId } });
    if (parent) this.syncInBackground(parent);
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

  /**
   * OAS-03: the stored spec index as the mapper needs it, loaded ONLY when the API governs endpoints (an
   * ungoverned API renders exactly as before and costs no query). Tenant-scoped, `endpointIndex` only.
   * Throws a 400 (-> FAILED with that message) for allow-list states the gateway cannot express safely.
   */
  private async endpointRefsFor(apiDef: ApiDefinition): Promise<EndpointRef[]> {
    const governance = readGovernanceState(readConfig(apiDef.config));
    if (!governance.restrictToSpec && Object.keys(governance.endpoints).length === 0) return [];

    const spec = await prisma.apiSpec.findFirst({
      where: { tenantId: apiDef.tenantId, apiDefId: apiDef.id },
      orderBy: { versionNo: 'desc' },
      select: { endpointIndex: true },
    });
    const rows: unknown[] = Array.isArray(spec?.endpointIndex) ? spec.endpointIndex : [];
    const refs = rows.flatMap((row): EndpointRef[] => {
      if (typeof row !== 'object' || row === null) return [];
      const { key, method, path } = row as Record<string, unknown>;
      return typeof key === 'string' && typeof method === 'string' && typeof path === 'string' ? [{ key, method, path }] : [];
    });

    if (governance.restrictToSpec && refs.length === 0) {
      // Fail closed: without endpoints nothing would carry `allow` and every path would be proxied.
      throw new BadRequestException('Allow-list mode is on but the stored specification has no endpoints');
    }
    if (governance.restrictToSpec && refs.length > MAX_MANAGED_ENDPOINTS) {
      throw new BadRequestException(
        `Allow-list mode is limited to ${String(MAX_MANAGED_ENDPOINTS)} endpoints; the specification has ${String(refs.length)}`,
      );
    }
    return refs;
  }

  /**
   * OAS-03 (intent vs effect): a node that accepted the push must also REPORT the governed operations as
   * sent. Only managed fields are compared, with subset semantics (Tyk may add defaults). A node that
   * does not becomes `ok: false`, so the row is FAILED rather than SYNCED from the write alone.
   */
  private async readBack(tykApiId: string, sent: Record<string, unknown>, nodes: NodeOutcome[]): Promise<NodeOutcome[]> {
    return Promise.all(
      nodes.map(async (node): Promise<NodeOutcome> => {
        if (!node.ok) return node;
        try {
          const mismatched = readBackMismatches(sent, await this.tykClient.getOasApiFromNode(tykApiId, node.nodeUrl));
          return mismatched.length === 0
            ? node
            : { ...node, ok: false, error: `read-back: ${String(mismatched.length)} governed operation(s) differ from what was sent` };
        } catch (err) {
          return { ...node, ok: false, error: `read-back failed: ${toSyncError(err)}` };
        }
      }),
    );
  }

  /** Push the definition to Tyk and persist the outcome: SYNCED + `lastSyncedAt`, or FAILED + `syncError`. */
  private async syncToTyk(apiDef: ApiDefinition): Promise<ApiRow> {
    return (await this.syncToTykWithNodes(apiDef)).row;
  }

  /**
   * As `syncToTyk`, but also hands back which nodes accepted the write — what `POST /apis/:id/sync`
   * needs to answer 207 rather than a 200 that hides a node having refused it.
   */
  private syncToTykWithNodes(apiDef: ApiDefinition): Promise<{ row: ApiRow; nodes: NodeOutcome[] }> {
    const previous = this.syncChains.get(apiDef.id) ?? Promise.resolve();
    const run = previous.then(async () => {
      // The caller's row may be a snapshot from before a later write: push what is stored NOW (tenant-scoped).
      const fresh = await prisma.apiDefinition.findFirst({ where: { id: apiDef.id, tenantId: apiDef.tenantId } });
      return this.syncToTykWithNodesNow(fresh?.id === apiDef.id ? fresh : apiDef);
    });
    const tail = run.catch(() => undefined);
    this.syncChains.set(apiDef.id, tail);
    void tail.then(() => {
      if (this.syncChains.get(apiDef.id) === tail) this.syncChains.delete(apiDef.id);
    });
    return run;
  }

  private async syncToTykWithNodesNow(apiDef: ApiDefinition): Promise<{ row: ApiRow; nodes: NodeOutcome[] }> {
    let tykApiId: string;
    let nodes: NodeOutcome[] = [];

    // Read once here rather than threading a tenant through every caller: the org and slug must be
    // identical across the definition and its JWT policy, and one query per sync is cheaper than the
    // chance of two call sites drifting apart. `tenantId` is a non-null FK, so this always resolves.
    const tenant = await loadTenantScope(apiDef.tenantId);

    let oasDocument: Prisma.InputJsonValue | undefined;

    try {
      const signingKey = await this.oauthSigningKey(apiDef.authType);

      if (apiDef.defFormat === ApiDefFormat.OAS) {
        // WP16: only a default (never a child — see mapToTykOas) can have `info.versioning`, and
        // only when it actually has an active version to route to. RETIRED children are excluded so
        // a retired version drops out of `versions` on the default's very next sync.
        const versions: ApiVersionChild[] =
          apiDef.parentApiId === null
            ? (
                await prisma.apiDefinition.findMany({
                  where: { parentApiId: apiDef.id, status: { not: ApiStatus.RETIRED } },
                  select: { versionName: true, tykApiId: true },
                })
              ).filter(
                (v): v is { versionName: string; tykApiId: string } => v.versionName !== null && v.tykApiId !== null,
              )
            : [];

        // `/tyk/apis/oas` POST is an upsert keyed by the document's own `info.id`, so create and
        // update are the same call — unlike the classic pair, which needs POST then PUT-by-id.
        const oasDef = mapToTykOas(apiDef, tenant, signingKey, versions, await this.endpointRefsFor(apiDef));
        tykApiId = apiDef.tykApiId ?? `og-${apiDef.id}`;
        nodes = await this.tykClient.upsertOasApi(oasDef);
        if (hasRealOperations(oasDef)) nodes = await this.readBack(tykApiId, oasDef, nodes);
        // Stored so drift and the UI can show what was actually sent, rather than re-deriving it
        // from a row that may have changed since.
        oasDocument = oasDef as Prisma.InputJsonValue;
      } else if (apiDef.tykApiId) {
        // Update existing
        nodes = (await this.tykClient.updateApi(apiDef.tykApiId, mapToTykFormat(apiDef, tenant, signingKey))).nodes;
        tykApiId = apiDef.tykApiId;
      } else {
        // Create new
        const created = await this.tykClient.createApi(mapToTykFormat(apiDef, tenant, signingKey));
        tykApiId = created.apiId;
        nodes = created.nodes;
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

      return {
        row: await prisma.apiDefinition.update({
          where: { id: apiDef.id },
          data: { syncStatus: ApiSyncStatus.FAILED, syncError },
          include: withActiveKeyCount,
        }),
        nodes,
      };
    }

    // A partial fan-out is not a clean sync: the definition is live on some nodes and stale on
    // others, so the row says so rather than reporting SYNCED and letting the drift tick discover it
    // a minute later.
    const failed = nodes.filter((n) => !n.ok);
    return {
      row: await prisma.apiDefinition.update({
        where: { id: apiDef.id },
        data: {
          tykApiId,
          ...(oasDocument === undefined ? {} : { oasDocument }),
          syncStatus: failed.length > 0 ? ApiSyncStatus.FAILED : ApiSyncStatus.SYNCED,
          syncError:
            failed.length > 0
              ? `${String(failed.length)} of ${String(nodes.length)} gateway nodes ${
                  failed.some((n) => n.error?.startsWith('read-back')) ? 'did not accept the definition or do not report it as sent' : 'did not accept the definition'
                }`
              : null,
          lastSyncedAt: new Date(),
          healthStatus: 'UNKNOWN' as const,
        },
        include: withActiveKeyCount,
      }),
      nodes,
    };
  }

  /**
   * Re-push to every node and report which ones took it. The controller turns a partial result into
   * 207; this returns the facts rather than deciding the status code.
   */
  async syncNowWithNodes(id: string, tenantId: string): Promise<{ detail: ApiDetail; nodes: NodeOutcome[] }> {
    const apiDef = await this.findRow(id, tenantId);
    const { row, nodes } = await this.syncToTykWithNodes(apiDef);
    return { detail: toApiDetail(row), nodes };
  }

  /**
   * Run a sample request against this API's own definition and return what the gateway saw.
   *
   * The definition is rebuilt from the stored row rather than accepted from the caller, so a test
   * request can only ever exercise an upstream this API is already configured for — or the one
   * `targetUrl` override, which carries the same SSRF deny list and is rejected with 400 before
   * anything is sent.
   */
  async debugRequest(id: string, tenantId: string, dto: DebugRequestDto): Promise<TykDebugResult> {
    const apiDef = await this.findRow(id, tenantId);
    const tenant = await loadTenantScope(apiDef.tenantId);
    const signingKey = await this.oauthSigningKey(apiDef.authType);

    // The override only changes where THIS test points; the stored row is untouched.
    const effective = dto.targetUrl ? { ...apiDef, proxyUrl: dto.targetUrl } : apiDef;

    let payload: Record<string, unknown>;
    try {
      payload =
        apiDef.defFormat === ApiDefFormat.OAS
          ? {
              request: buildDebugRequest(dto),
              oas: mapToTykOas(effective, tenant, signingKey, [], await this.endpointRefsFor(apiDef)),
            }
          : { request: buildDebugRequest(dto), spec: mapToTykFormat(effective, tenant, signingKey) };
    } catch (err) {
      // A governed definition the mapper refuses to render is the caller's configuration, not a 500.
      if (err instanceof EndpointRenderError) throw new BadRequestException(err.message);
      throw err;
    }

    return this.tykClient.debug(payload);
  }

  /**
   * Drop this API's cached responses. Tenant-scoped through `findRow`, so one tenant cannot flush
   * another's cache by guessing an id.
   */
  async invalidateCache(
    id: string,
    tenantId: string,
  ): Promise<{ invalidated: boolean; keysDropped: number; nodes: NodeOutcome[] }> {
    const apiDef = await this.findRow(id, tenantId);
    if (!apiDef.tykApiId) return { invalidated: false, keysDropped: 0, nodes: [] };

    const { nodes, keysDropped } = await this.tykClient.invalidateCache(apiDef.tykApiId);
    // `invalidated` reports whether cache entries were actually dropped, NOT whether the gateway
    // answered 200 — Tyk's own endpoint answers 200 while doing nothing, and reporting that as
    // success is the exact failure this route exists to avoid.
    return { invalidated: keysDropped > 0, keysDropped, nodes };
  }

  /**
   * Per-node drift for one definition, recomputed on demand so the caller never reads a stale tick.
   * `differences` lists the nodes that disagree with the majority hash (or that could not be read),
   * which is what an operator acts on.
   */
  async drift(
    id: string,
    tenantId: string,
  ): Promise<{ inSync: boolean; differences: string[]; perNode: SyncState['nodes'] }> {
    const apiDef = await this.findRow(id, tenantId);
    if (!apiDef.tykApiId) {
      return { inSync: false, differences: ['never synced to the gateway'], perNode: {} };
    }

    const state = await this.reconcile.reconcileOne(apiDef.id, apiDef.tykApiId, apiDef.defFormat);
    const hashes = Object.values(state.nodes)
      .map((n) => n.hash)
      .filter((h): h is string => h !== null);
    const majority = hashes
      .sort(
        (a, b) => hashes.filter((h) => h === b).length - hashes.filter((h) => h === a).length,
      )
      .at(0);

    const differences = Object.entries(state.nodes)
      .filter(([, view]) => !view.present || view.hash !== majority)
      .map(([nodeUrl, view]) => `${nodeUrl}: ${view.error ?? 'definition differs'}`);

    return { inSync: state.inSync, differences, perNode: state.nodes };
  }
}
