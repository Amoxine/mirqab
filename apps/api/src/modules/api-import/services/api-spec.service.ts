import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import type { EndpointRow } from './oas-endpoints';

/** The stored specification without its (up to 5 MB) source text. */
export interface ApiSpecSummary {
  versionNo: number;
  contentHash: string;
  format: string;
  openapiVersion: string;
  endpointCount: number;
  createdAt: Date;
}

export interface ApiSpecDocument extends ApiSpecSummary {
  sourceText: string;
}

export interface ApiEndpointList extends ApiSpecSummary {
  endpoints: EndpointRow[];
}

const SUMMARY_SELECT = {
  versionNo: true,
  contentHash: true,
  format: true,
  openapiVersion: true,
  endpointCount: true,
  createdAt: true,
} as const;

/**
 * Reads over `api_specs` (OAS-01). Every query carries `tenantId`: there is no row-level security
 * behind it, and a spec of another tenant's API must look exactly like a missing one (404).
 */
@Injectable()
export class ApiSpecService {
  /** Whether an import would collide with an existing API of THIS tenant. */
  async conflicts(tenantId: string, slug: string, listenPath: string): Promise<{ slug: boolean; listenPath: boolean }> {
    const rows = await prisma.apiDefinition.findMany({
      where: { tenantId, OR: [{ slug }, { listenPath }] },
      select: { slug: true, listenPath: true },
    });
    return {
      slug: rows.some((row) => row.slug === slug),
      listenPath: rows.some((row) => row.listenPath === listenPath),
    };
  }

  /** The newest stored version, source text included. */
  async latest(tenantId: string, apiDefId: string): Promise<ApiSpecDocument> {
    const row = await prisma.apiSpec.findFirst({
      where: { tenantId, apiDefId },
      orderBy: { versionNo: 'desc' },
      select: { ...SUMMARY_SELECT, sourceText: true },
    });
    if (!row) throw new NotFoundException(`No specification is stored for API ${apiDefId}`);
    return row;
  }

  /** The newest stored version's endpoint index, without the source text. */
  async latestEndpoints(tenantId: string, apiDefId: string): Promise<ApiEndpointList> {
    const row = await prisma.apiSpec.findFirst({
      where: { tenantId, apiDefId },
      orderBy: { versionNo: 'desc' },
      select: { ...SUMMARY_SELECT, endpointIndex: true },
    });
    if (!row) throw new NotFoundException(`No specification is stored for API ${apiDefId}`);
    const { endpointIndex, ...summary } = row;
    return { ...summary, endpoints: Array.isArray(endpointIndex) ? (endpointIndex as unknown as EndpointRow[]) : [] };
  }
}
