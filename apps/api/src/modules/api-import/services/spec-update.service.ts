import { ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, prisma } from '@open-gateway/database';
import { ApiService } from '../../api-management/services/api.service';
import { readGovernanceState, type EndpointGovernance } from '../../api-management/services/endpoint-governance';
import { ApiImportService, toDetails } from './api-import.service';
import { MAX_ENDPOINTS, type EndpointRow } from './oas-endpoints';
import { diffEndpoints, governanceImpact, type GovernanceImpact, type SpecDiff } from './spec-diff';
import type { LintFinding } from './spectral-lint.service';

export interface SpecUpdateOptions {
  /** `POST /apis/:id/spec/preview`: compute everything, write nothing. */
  dryRun: boolean;
  /** The `versionNo` the caller last saw; 0 = "this API has no stored spec yet". Anything else is 409. */
  expectedVersion: number;
  /** Required to apply a document that drops governed endpoints. */
  acknowledgeRemoved: boolean;
  /**
   * OAS-08: runs INSIDE the apply transaction, after the new version and the config guard. Throwing
   * rolls the new version back (a candidate that is no longer PENDING must not be applied).
   */
  onApplied?: (tx: Prisma.TransactionClient) => Promise<void>;
}

export interface SpecUpdateResult {
  dryRun: boolean;
  applied: boolean;
  /** Same bytes as the latest version: nothing written, no new version. */
  unchanged: boolean;
  /** The latest version after the call. */
  versionNo: number;
  findings: LintFinding[];
  diff: SpecDiff;
  governanceImpact: GovernanceImpact<EndpointGovernance>;
  /** OAS-08: what the submitted document is, so a caller storing a candidate need not lint it twice. */
  document: { contentHash: string; format: 'json' | 'yaml'; openapiVersion: string; endpointCount: number };
}

const EMPTY_DIFF: SpecDiff = { added: [], removed: [], changed: [] };

const stale = (expected: number, latest: number): ConflictException =>
  new ConflictException({
    message: `The specification is at version ${String(latest)}, not ${String(expected)}. Reload it and review the diff again.`,
    error: 'SPEC_VERSION_STALE',
  });

/**
 * `POST /apis/:id/spec` (OAS-04): upload a changed OpenAPI document onto an existing API, see what it
 * changes, and apply it as the next stored version.
 *
 * Applying writes ONLY `api_specs` (a new row) and `syncStatus`. Endpoint governance lives in
 * `config.endpoints` keyed by endpoint key, so it survives on every key the new index still has and
 * becomes an orphan (reported, not emitted, never deleted) on every key it lost — no `config` write.
 */
@Injectable()
export class SpecUpdateService {
  private readonly logger = new Logger(SpecUpdateService.name);

  constructor(
    private readonly importer: ApiImportService,
    private readonly apis: ApiService,
  ) {}

  async update(source: string, tenantId: string, apiDefId: string, options: SpecUpdateOptions): Promise<SpecUpdateResult> {
    const api = await prisma.apiDefinition.findFirst({ where: { id: apiDefId, tenantId }, select: { config: true } });
    if (!api) throw new NotFoundException('API definition not found');
    const latest = await prisma.apiSpec.findFirst({
      where: { tenantId, apiDefId },
      orderBy: { versionNo: 'desc' },
      select: { versionNo: true, contentHash: true, endpointIndex: true },
    });

    // ponytail: the import preview IS the import's gate chain (5 MB, alias budget, external $ref, lint,
    // parse, 3.x only, endpoint cap) and writes nothing; reusing it keeps the two paths identical.
    // Its derived-API fields (slug, upstream) are ignored: a re-upload changes neither.
    const analysis = await this.importer.preview(source, tenantId);
    if ('endpoints' in analysis.problems) {
      throw new UnprocessableEntityException({
        message: `The document declares more than ${String(MAX_ENDPOINTS)} operations`,
        error: 'OAS_IMPORT_TOO_MANY_ENDPOINTS',
        details: {},
      });
    }

    const governance = readGovernanceState(config(api.config)).endpoints;
    const document = {
      contentHash: analysis.contentHash,
      format: analysis.format,
      openapiVersion: analysis.openapiVersion,
      endpointCount: analysis.endpoints.length,
    };
    const nothing = { findings: analysis.findings, diff: EMPTY_DIFF, governanceImpact: { removedGoverned: [], changedGoverned: [] }, document };

    // Checked before the version: re-sending the bytes that are already stored (a retry after a lost
    // response) is answered `unchanged`, not 409, so the upload is idempotent.
    if (analysis.contentHash === latest?.contentHash) {
      return { dryRun: options.dryRun, applied: false, unchanged: true, versionNo: latest.versionNo, ...nothing };
    }
    // An API created by hand has no spec: version 0, so `expectedVersion=0` attaches its first one.
    const latestVersion = latest?.versionNo ?? 0;
    if (options.expectedVersion !== latestVersion) throw stale(options.expectedVersion, latestVersion);

    const before = Array.isArray(latest?.endpointIndex) ? (latest.endpointIndex as unknown as EndpointRow[]) : [];
    const diff = diffEndpoints(before, analysis.endpoints);
    const impact = governanceImpact(diff, governance);
    const result = { findings: analysis.findings, diff, governanceImpact: impact, document };

    if (options.dryRun) {
      return { dryRun: true, applied: false, unchanged: false, versionNo: latestVersion, ...result };
    }

    if (analysis.findings.some((finding) => finding.severity === 'error')) {
      throw new UnprocessableEntityException({
        message: 'OAS document failed the lint gate',
        error: 'OAS_LINT_FAILED',
        details: toDetails(analysis.findings),
      });
    }
    if (impact.removedGoverned.length > 0 && !options.acknowledgeRemoved) {
      throw new ConflictException({
        message:
          'The document removes endpoints that have governance. Their operations stop being sent to the gateway at the ' +
          'next sync; their settings are kept as orphans. Re-send with acknowledgeRemoved=true to apply.',
        error: 'SPEC_REMOVES_GOVERNED_ENDPOINTS',
        details: { removedGoverned: impact.removedGoverned.map((entry) => entry.key) },
      });
    }

    const versionNo = latestVersion + 1;
    try {
      await prisma.$transaction(async (tx) => {
        // Compare-and-set on the latest version. The unique (api_def_id, version_no) index is the
        // backstop for two uploads that both pass this read: the second insert fails, mapped to 409.
        const current = await tx.apiSpec.findFirst({
          where: { tenantId, apiDefId },
          orderBy: { versionNo: 'desc' },
          select: { versionNo: true },
        });
        if ((current?.versionNo ?? 0) !== latestVersion) throw stale(options.expectedVersion, current?.versionNo ?? 0);

        await tx.apiSpec.create({
          data: {
            tenantId,
            apiDefId,
            versionNo,
            contentHash: analysis.contentHash,
            format: analysis.format,
            openapiVersion: analysis.openapiVersion,
            sourceText: source,
            endpointIndex: analysis.endpoints as unknown as Prisma.InputJsonValue,
            endpointCount: analysis.endpoints.length,
          },
        });

        // The governance impact above was computed from this config. If a governance PATCH landed in
        // between, that answer may be wrong (a newly governed key removed without acknowledgement).
        const marked = await tx.apiDefinition.updateMany({
          where: { id: apiDefId, tenantId, config: { equals: api.config ?? Prisma.AnyNull } },
          data: { syncStatus: 'PENDING' },
        });
        if (marked.count === 0) {
          throw new ConflictException({
            message: 'The configuration of this API (its endpoint governance, for example) changed during the upload. Review the diff again.',
            error: 'SPEC_GOVERNANCE_CHANGED',
          });
        }
        await options.onApplied?.(tx);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw stale(options.expectedVersion, versionNo);
      }
      throw err;
    }

    // After the commit, never inside it: the gateway push reads the new index. `syncNow` records a
    // failed push on the row itself (FAILED + syncError), so only a database error can land here.
    this.apis.syncNow(apiDefId, tenantId).catch((err: unknown) => {
      this.logger.error(`Failed to record sync of API ${apiDefId}: ${err instanceof Error ? err.message : String(err)}`);
    });

    return { dryRun: false, applied: true, unchanged: false, versionNo, ...result };
  }
}

function config(value: Prisma.JsonValue | null): { endpoints?: unknown; restrictToSpec?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}
