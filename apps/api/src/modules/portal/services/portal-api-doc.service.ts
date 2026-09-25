import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ApiStatus } from '@prisma/client';
import { parseYaml } from '@stoplight/spectral-parsers';
import { prisma } from '@open-gateway/database';
import { ApiService, RetiredVersionException, type ApiDetail } from '../../api-management/services/api.service';
import { gatewayListenPath } from '../../api-management/services/tyk-mappers';
import { yamlAliasHazard } from '../../api-import/services/oas-safety';
import { loadTenantScope } from '../../tyk-integration/services/tenant-scope';
import { blockedEndpointKeys, sanitizePortalSpec } from './portal-spec-sanitizer';

/**
 * `GET /portal/catalog/apis/:id` (WP23, OAS-06): just enough of `ApiDetail` for the docs page — the
 * document a developer may read and the try-it console's request target.
 */
export interface PortalApiDoc {
  id: string;
  name: string;
  authType: string;
  authHeaderName?: string;
  /** `/{tenantSlug}{listenPath}` — what the gateway actually routes on (O10), pre-computed here so
   * the frontend never re-derives the tenant-prefix formula. */
  gatewayListenPath: string;
  /**
   * The SANITIZED OpenAPI document (`portal-spec-sanitizer.ts`): the API's stored specification when
   * it has one, else the generated document. `servers` is the one gateway URL, relative to the
   * gateway origin. Null for a classic API, or a stored spec that cannot be served.
   */
  oasDocument: Record<string, unknown> | null;
}

type Doc = Record<string, unknown>;

/**
 * Sanitized documents kept between requests, weighed by their serialized size (what actually stays
 * in memory; the source text says little about it, whitespace and comments included).
 * Parsing is the cost, not sanitizing: the YAML parser took 2.6 s for a 1.6 MB document (JSON.parse:
 * 49 ms), and one Node process serves every route, so a docs page must not pay that per view.
 * ponytail: per process and FIFO; a shared cache only matters with more than one API replica. The
 * cached OBJECT is served (Nest serializes it per response): JSON cannot embed a pre-serialized string.
 */
const CACHE_BUDGET = 8 * 1024 * 1024;

/** The stored source as data, or undefined when it cannot be parsed. The YAML parser throws on some input (`!!binary`). */
function parseSource(source: string, format: string): unknown {
  try {
    if (format === 'json') return JSON.parse(source);
    return yamlAliasHazard(source) ? undefined : parseYaml(source).data;
  } catch {
    return undefined;
  }
}

/**
 * Builds what the developer portal serves for one API.
 *
 * Who may read it: the API must exist in the developer's tenant (`ApiService.findOne`, 404 for another
 * tenant's id), be ACTIVE, and belong to at least one product of that tenant. Products are the
 * catalog's unit of publication (the catalog lists every product of the tenant; there is no
 * visibility flag), so an API in no product is not published. Anything else answers the SAME 404 as
 * a missing id, so the response tells a developer nothing about drafts, disabled or retired APIs.
 * Every `api_specs` query carries `tenantId`.
 */
@Injectable()
export class PortalApiDocService {
  private readonly logger = new Logger(PortalApiDocService.name);
  private readonly cache = new Map<string, { document: Doc | null; weight: number }>();
  /** Builds under way: concurrent misses share one read + parse instead of each paying for it. */
  private readonly inFlight = new Map<string, Promise<Doc | null>>();
  private cachedWeight = 0;

  constructor(private readonly apis: ApiService) {}

  async forTenant(id: string, tenantId: string): Promise<PortalApiDoc> {
    const api = await this.findPublished(id, tenantId);
    const tenant = await loadTenantScope(tenantId);
    const listenPath = gatewayListenPath(tenant.slug, api.listenPath);
    // OpenAPI joins `server.url + path`, so the trailing slash of the listen path would double up.
    const serverUrl = listenPath.replace(/\/+$/, '');

    const latest = await prisma.apiSpec.findFirst({
      where: { tenantId, apiDefId: api.id },
      orderBy: { versionNo: 'desc' },
      select: { versionNo: true, contentHash: true, format: true },
    });

    // A stored spec that cannot be served answers null, never the generated document: that one
    // documents governed endpoints as synthetic operations, blocked ones included.
    const oasDocument = latest
      ? await this.fromStoredSpec(api.id, tenantId, latest, serverUrl, blockedEndpointKeys(api.config))
      : sanitizePortalSpec(api.oasDocument, { serverUrl });

    return {
      id: api.id,
      name: api.name,
      authType: api.authType,
      authHeaderName: api.config.authHeaderName,
      gatewayListenPath: listenPath,
      oasDocument,
    };
  }

  private async findPublished(id: string, tenantId: string): Promise<ApiDetail> {
    const notFound = () => new NotFoundException('API definition not found');
    let api: ApiDetail;
    try {
      api = await this.apis.findOne(id, tenantId);
    } catch (error) {
      // A retired version answers 410 to the dashboard; to a portal developer it is just not there.
      throw error instanceof RetiredVersionException ? notFound() : error;
    }
    if (api.status !== ApiStatus.ACTIVE) throw notFound();

    const listed = await prisma.productApi.findFirst({
      where: { apiDefId: api.id, product: { tenantId } },
      select: { productId: true },
    });
    if (!listed) throw notFound();
    return api;
  }

  private fromStoredSpec(
    apiDefId: string,
    tenantId: string,
    latest: { versionNo: number; contentHash: string; format: string },
    serverUrl: string,
    blockedKeys: ReadonlySet<string>,
  ): Promise<Doc | null> {
    // JSON, not a joined string: a blocked key may contain any character, a separator included.
    const cacheKey = JSON.stringify([apiDefId, latest.contentHash, serverUrl, [...blockedKeys].sort()]);
    const hit = this.cache.get(cacheKey);
    if (hit) return Promise.resolve(hit.document);

    let pending = this.inFlight.get(cacheKey);
    if (!pending) {
      pending = this.build(cacheKey, apiDefId, tenantId, latest, serverUrl, blockedKeys).finally(() => {
        this.inFlight.delete(cacheKey);
      });
      this.inFlight.set(cacheKey, pending);
    }
    return pending;
  }

  private async build(
    cacheKey: string,
    apiDefId: string,
    tenantId: string,
    latest: { versionNo: number; format: string },
    serverUrl: string,
    blockedKeys: ReadonlySet<string>,
  ): Promise<Doc | null> {
    const row = await prisma.apiSpec.findFirst({
      where: { tenantId, apiDefId, versionNo: latest.versionNo },
      select: { sourceText: true },
    });
    if (!row) return null;

    const parsed = parseSource(row.sourceText, latest.format);
    const document = sanitizePortalSpec(parsed, { serverUrl, blockedKeys });
    if (document === null) {
      this.logger.warn(`Stored spec v${String(latest.versionNo)} of API ${apiDefId} cannot be served to the portal`);
    }
    this.remember(cacheKey, document);
    return document;
  }

  private remember(key: string, document: Doc | null): void {
    const weight = document === null ? 1 : JSON.stringify(document).length;
    if (weight > CACHE_BUDGET) return;
    this.cache.set(key, { document, weight });
    this.cachedWeight += weight;
    // Map iterates in insertion order, so the first key is the oldest.
    for (const [oldest, entry] of this.cache) {
      if (this.cachedWeight <= CACHE_BUDGET) break;
      this.cache.delete(oldest);
      this.cachedWeight -= entry.weight;
    }
  }
}
