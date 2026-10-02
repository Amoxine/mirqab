import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ApiDefFormat, ApiProtocol, type ApiSyncStatus, type Prisma } from '@prisma/client';
import { prisma } from '@open-gateway/database';
import { ApiService } from './api.service';
import { readConfig } from './tyk-mappers';
import { governanceCapabilities } from './endpoint-capabilities';
import {
  applyEndpointChange,
  governanceConfigPatch,
  governanceRevision,
  orphansOf,
  readGovernanceState,
  type EndpointChange,
  type EndpointGovernance,
  type IndexedEndpoint,
} from './endpoint-governance';

/** A stored index row (an `EndpointRow` of `oas-endpoints.ts`), passed through as stored. */
export type StoredEndpointRow = IndexedEndpoint & Record<string, unknown>;

export interface EndpointGovernanceView {
  versionNo: number;
  contentHash: string;
  format: string;
  openapiVersion: string;
  endpointCount: number;
  createdAt: Date;
  endpoints: (StoredEndpointRow & { governance: EndpointGovernance | null })[];
  orphans: { key: string; governance: EndpointGovernance }[];
  restrictToSpec: boolean;
  revision: string;
  syncStatus: ApiSyncStatus;
  syncError: string | null;
  capabilities: ReturnType<typeof governanceCapabilities>;
}

export type EndpointGovernanceUpdate = EndpointChange & { expectedRevision: string };

const stale = (): ConflictException =>
  new ConflictException({
    message: 'Endpoint governance changed since it was read; reload and retry',
    error: 'ENDPOINT_REVISION_STALE',
  });

/** Rows of the stored index that have the fields the model needs; anything else is skipped, not trusted. */
function indexRows(value: Prisma.JsonValue): StoredEndpointRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row): StoredEndpointRow[] => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return [];
    const { key, method, path, tags } = row as Record<string, unknown>;
    if (typeof key !== 'string' || typeof method !== 'string' || typeof path !== 'string') return [];
    const safeTags = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
    return [{ ...(row as Record<string, unknown>), key, method, path, tags: safeTags }];
  });
}

/**
 * `GET`/`PATCH /apis/:id/endpoints` (OAS-03). Every query carries `tenantId` (no RLS behind it); another
 * tenant's API is a 404. The write is ONE compare-and-set on the whole `config` — no transaction is held
 * while the gateway is called; the sync that follows is the normal background one, with read-back.
 */
@Injectable()
export class EndpointGovernanceService {
  constructor(private readonly apis: ApiService) {}

  async list(tenantId: string, apiDefId: string): Promise<EndpointGovernanceView> {
    const { api, spec } = await this.load(tenantId, apiDefId);
    if (!spec) throw new NotFoundException(`No specification is stored for API ${apiDefId}`);

    const state = readGovernanceState(readConfig(api.config));
    const rows = indexRows(spec.endpointIndex);
    const { endpointIndex: _index, ...summary } = spec;
    return {
      ...summary,
      endpoints: rows.map((row) => ({
        ...row,
        governance: Object.prototype.hasOwnProperty.call(state.endpoints, row.key) ? (state.endpoints[row.key] ?? null) : null,
      })),
      orphans: orphansOf(state, rows),
      restrictToSpec: state.restrictToSpec,
      revision: governanceRevision(state, spec.versionNo),
      syncStatus: api.syncStatus,
      syncError: api.syncError,
      capabilities: governanceCapabilities(),
    };
  }

  async update(tenantId: string, apiDefId: string, change: EndpointGovernanceUpdate): Promise<EndpointGovernanceView> {
    const { api, spec } = await this.load(tenantId, apiDefId);
    if (api.defFormat !== ApiDefFormat.OAS || api.protocol !== ApiProtocol.HTTP) {
      throw new BadRequestException('Endpoint governance needs an HTTP API defined from an OpenAPI document');
    }
    if (!spec) throw new BadRequestException('Endpoint governance needs a stored OpenAPI specification');

    const config = readConfig(api.config);
    const state = readGovernanceState(config);
    if (governanceRevision(state, spec.versionNo) !== change.expectedRevision) throw stale();

    const result = applyEndpointChange(state, indexRows(spec.endpointIndex), change, Boolean(config.cache));
    if (!result.ok) throw new BadRequestException(result.error);

    const { endpoints: _endpoints, restrictToSpec: _restrict, ...rest } = config;
    const next = JSON.parse(JSON.stringify({ ...rest, ...governanceConfigPatch(result.state) })) as Prisma.InputJsonObject;
    // A writer that read the same revision but committed first makes this match nothing: 409, never an overwrite.
    if (!(await this.apis.compareAndSetConfig(apiDefId, tenantId, api.config, next))) throw stale();

    return this.list(tenantId, apiDefId);
  }

  private async load(tenantId: string, apiDefId: string) {
    const [api, spec] = await Promise.all([
      prisma.apiDefinition.findFirst({
        where: { id: apiDefId, tenantId },
        select: { config: true, syncStatus: true, syncError: true, defFormat: true, protocol: true },
      }),
      prisma.apiSpec.findFirst({
        where: { tenantId, apiDefId },
        orderBy: { versionNo: 'desc' },
        select: {
          versionNo: true,
          contentHash: true,
          format: true,
          openapiVersion: true,
          endpointCount: true,
          createdAt: true,
          endpointIndex: true,
        },
      }),
    ]);
    if (!api) throw new NotFoundException('API definition not found');
    return { api, spec };
  }
}
