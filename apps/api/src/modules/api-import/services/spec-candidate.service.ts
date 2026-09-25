import { ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, prisma } from '@open-gateway/database';
import type { SpecCandidateState } from '@prisma/client';
import { pendingSpecCandidates } from '../../api-management/services/api.service';
import { AuditService } from '../../audit/services/audit.service';
import { contentHashOf } from './oas-endpoints';
import { SpecUpdateService, type SpecUpdateResult } from './spec-update.service';
import type { LintFinding } from './spectral-lint.service';

/** Candidates kept per API (newest first); older decided ones are deleted. */
export const CANDIDATE_RETENTION = 20;
/** Warnings stored with a candidate; the full list is recomputed by the diff route anyway. */
const MAX_STORED_FINDINGS = 100;

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  governedRemoved: number;
  governedChanged: number;
}

export interface CandidateSummary {
  id: string;
  contentHash: string;
  state: SpecCandidateState;
  detectedAt: Date;
  decidedAt: Date | null;
  endpointCount: number;
  baseVersionNo: number;
  diff: DiffSummary;
}

export interface Candidate extends CandidateSummary {
  format: string;
  openapiVersion: string;
  /** Warnings only: a document with a lint error never becomes a candidate. */
  findings: LintFinding[];
}

export type CheckResult = 'UNCHANGED' | 'CHANGED' | 'ERROR';

/** What one look at a spec URL's document concluded. `null` from `detect` = the API or source is gone. */
export interface Detection {
  result: CheckResult;
  errorCode?: string;
  candidate?: CandidateSummary;
}

export interface SpecUpdateItem {
  apiId: string;
  apiName: string;
  candidateId: string;
  detectedAt: Date;
  diff: DiffSummary;
}

const summarySelect = {
  id: true,
  contentHash: true,
  state: true,
  detectedAt: true,
  decidedAt: true,
  endpointCount: true,
  baseVersionNo: true,
  diffSummary: true,
} satisfies Prisma.SpecCandidateSelect;

type SummaryRow = Prisma.SpecCandidateGetPayload<{ select: typeof summarySelect }>;

const EMPTY_SUMMARY: DiffSummary = { added: 0, removed: 0, changed: 0, governedRemoved: 0, governedChanged: 0 };

function toSummary(row: SummaryRow): CandidateSummary {
  const { diffSummary, ...rest } = row;
  const diff = typeof diffSummary === 'object' && diffSummary !== null && !Array.isArray(diffSummary) ? diffSummary : {};
  return { ...rest, diff: { ...EMPTY_SUMMARY, ...(diff as Partial<DiffSummary>) } };
}

export function summarise(result: SpecUpdateResult): DiffSummary {
  return {
    added: result.diff.added.length,
    removed: result.diff.removed.length,
    changed: result.diff.changed.length,
    governedRemoved: result.governanceImpact.removedGoverned.length,
    governedChanged: result.governanceImpact.changedGoverned.length,
  };
}

const candidateStale = (): ConflictException =>
  new ConflictException({
    message: 'This proposed version is no longer pending (applied, dismissed or replaced). Check the URL again.',
    error: 'CANDIDATE_STALE',
  });

/** Leaving PENDING always drops the text: only a pending candidate needs its (up to 5 MB) document. */
const decided = (state: 'APPLIED' | 'DISMISSED' | 'SUPERSEDED', now: Date, userId?: string) => ({
  state,
  decidedAt: now,
  decidedBy: userId ?? null,
  sourceText: null,
});

/**
 * The database clock, shared by every replica: `detected_at` (retention and "which row is newest"
 * order by it), `decided_at`, the claim and the cooldown all read it.
 */
export async function dbNow(client: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma): Promise<Date> {
  const [row] = await client.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return row.now;
}

/**
 * Why a detection did not conclude: the source was removed (`GONE`), or its URL was edited while the
 * old URL was being fetched (`SOURCE_CHANGED`) — that document belongs to nobody any more.
 */
export type DetectionAbort = 'GONE' | 'SOURCE_CHANGED';

/**
 * OAS-08: versions a watched spec URL served, proposed to a human. Detection stores them; the routes
 * list, diff, apply (through OAS-04's `SpecUpdateService.update`, never a second apply path) or dismiss
 * them. Nothing here talks to the gateway: only an apply does, through the OAS-04 sync.
 */
@Injectable()
export class SpecCandidateService {
  constructor(
    private readonly specUpdate: SpecUpdateService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The detection matrix (plan §6 + REV 2) for a document just fetched from `url`. Runs the OAS-04 gate
   * chain as a dry run; a document failing it is `ERROR NOT_A_SPEC`, never a candidate. Content already
   * waiting as PENDING answers `CHANGED` with that candidate, so the source keeps saying "update waiting".
   */
  async detect(tenantId: string, apiDefId: string, text: string, url: string): Promise<Detection | DetectionAbort> {
    const source = await prisma.apiSpecSource.findFirst({ where: { apiDefId, tenantId }, select: { url: true } });
    if (!source) return 'GONE';
    if (source.url !== url) return 'SOURCE_CHANGED';

    const hash = contentHashOf(text);
    const latest = await prisma.apiSpec.findFirst({
      where: { tenantId, apiDefId },
      orderBy: { versionNo: 'desc' },
      select: { versionNo: true, contentHash: true },
    });
    if (hash === latest?.contentHash) {
      // The URL serves what is applied (it reverted, or the new version was uploaded by hand).
      await this.supersedePending(tenantId, apiDefId);
      return { result: 'UNCHANGED' };
    }
    // Cheap pre-check before the lint: content already proposed, or dismissed (silent until it changes).
    const known = await prisma.specCandidate.findFirst({
      where: { tenantId, apiDefId, contentHash: hash },
      orderBy: { detectedAt: 'desc' },
      select: summarySelect,
    });
    if (known?.state === 'PENDING') return { result: 'CHANGED', candidate: toSummary(known) };
    if (known?.state === 'DISMISSED') {
      await this.supersedePending(tenantId, apiDefId);
      return { result: 'UNCHANGED' };
    }

    let dry: SpecUpdateResult;
    try {
      dry = await this.specUpdate.update(text, tenantId, apiDefId, {
        dryRun: true,
        expectedVersion: latest?.versionNo ?? 0,
        acknowledgeRemoved: false,
      });
    } catch (err) {
      if (err instanceof NotFoundException) return 'GONE';
      // A version applied between the read above and the dry run: not the document's fault. Thrown; the
      // caller records CHECK_FAILED and the source is retried at its next interval.
      if (err instanceof ConflictException) throw err;
      // 413 / 422: too large, unparseable, not 3.x, unsafe, too many operations.
      if (err instanceof HttpException && err.getStatus() < 500) return { result: 'ERROR', errorCode: 'NOT_A_SPEC' };
      throw err;
    }
    if (dry.findings.some((finding) => finding.severity === 'error')) return { result: 'ERROR', errorCode: 'NOT_A_SPEC' };
    if (dry.unchanged) return { result: 'UNCHANGED' };

    const summary = summarise(dry);
    const data = {
      contentHash: hash,
      format: dry.document.format,
      openapiVersion: dry.document.openapiVersion,
      sourceText: text,
      endpointCount: dry.document.endpointCount,
      baseVersionNo: dry.versionNo,
      diffSummary: summary as unknown as Prisma.InputJsonValue,
      findings: dry.findings.slice(0, MAX_STORED_FINDINGS) as unknown as Prisma.InputJsonValue,
    };

    const stored = await prisma.$transaction(async (tx) => {
      // Serialises every detection of this API (the scheduler, "check now", a second replica) so there
      // is at most one PENDING row, and orders it against the source's removal or URL edit.
      const locked = await tx.$queryRaw<{ id: string; url: string }[]>`
        SELECT id, url FROM api_spec_sources WHERE api_def_id = ${apiDefId} AND tenant_id = ${tenantId} FOR UPDATE`;
      if (locked.length === 0) return 'GONE' as const;
      if (locked[0].url !== url) return 'SOURCE_CHANGED' as const;

      // Re-read under the lock: an apply of this very content may have committed since the read above;
      // resetting its APPLIED row to PENDING would be a false CHANGED (and a false audit row).
      const current = await tx.apiSpec.findFirst({
        where: { tenantId, apiDefId },
        orderBy: { versionNo: 'desc' },
        select: { contentHash: true },
      });
      if (current?.contentHash === hash) return { known: 'UNCHANGED' } as const;

      const existing = await tx.specCandidate.findFirst({
        where: { tenantId, apiDefId, contentHash: hash },
        orderBy: { detectedAt: 'desc' },
        select: summarySelect,
      });
      if (existing?.state === 'DISMISSED') return { known: 'UNCHANGED' } as const;
      if (existing?.state === 'PENDING') return { known: 'PENDING', row: existing } as const;

      const now = await dbNow(tx);
      await tx.specCandidate.updateMany({ where: { tenantId, apiDefId, state: 'PENDING' }, data: decided('SUPERSEDED', now) });
      // A→B→A: content seen before (APPLIED or SUPERSEDED) that differs from the applied version is
      // proposed again by resetting its row — the (api_def_id, content_hash) index is not unique.
      const row = existing
        ? await tx.specCandidate.update({
            where: { id: existing.id },
            data: { ...data, state: 'PENDING', detectedAt: now, decidedAt: null, decidedBy: null },
            select: summarySelect,
          })
        : await tx.specCandidate.create({ data: { tenantId, apiDefId, ...data }, select: summarySelect });

      const old = await tx.specCandidate.findMany({
        where: { tenantId, apiDefId },
        orderBy: { detectedAt: 'desc' },
        skip: CANDIDATE_RETENTION,
        select: { id: true },
      });
      if (old.length > 0) {
        await tx.specCandidate.deleteMany({ where: { tenantId, id: { in: old.map((r) => r.id) }, state: { not: 'PENDING' } } });
      }
      return row;
    });

    if (stored === 'GONE' || stored === 'SOURCE_CHANGED') return stored;
    if ('known' in stored) {
      return stored.known === 'PENDING' ? { result: 'CHANGED', candidate: toSummary(stored.row) } : { result: 'UNCHANGED' };
    }
    // A system event: no user, no correlation id. `record` never throws.
    await this.audit.record({
      tenantId,
      action: 'SPEC_UPDATE_DETECTED',
      resource: 'apis',
      details: { resourceId: apiDefId, candidateId: stored.id, contentHash: hash, diff: summary },
    });
    return { result: 'CHANGED', candidate: toSummary(stored) };
  }

  /** Pending rows of an API stop being proposed (the URL moved on, reverted, or the source was removed). */
  async supersedePending(tenantId: string, apiDefId: string, tx: Prisma.TransactionClient = prisma): Promise<void> {
    await tx.specCandidate.updateMany({ where: { tenantId, apiDefId, state: 'PENDING' }, data: decided('SUPERSEDED', await dbNow(tx)) });
  }

  /**
   * PENDING rows whose content IS the latest version (uploaded by hand, or applied elsewhere) are moot:
   * SUPERSEDED, text dropped. Run on a list and on a 304 (a 304 never reaches `detect`).
   */
  async settleStale(tenantId: string, apiDefId: string): Promise<void> {
    const latest = await prisma.apiSpec.findFirst({
      where: { tenantId, apiDefId },
      orderBy: { versionNo: 'desc' },
      select: { contentHash: true },
    });
    if (!latest) return;
    await prisma.specCandidate.updateMany({
      where: { tenantId, apiDefId, state: 'PENDING', contentHash: latest.contentHash },
      data: decided('SUPERSEDED', await dbNow()),
    });
  }

  /** The proposal still waiting for a decision (derived rule), if any. */
  async waiting(tenantId: string, apiDefId: string): Promise<CandidateSummary | null> {
    const pending = (await pendingSpecCandidates(tenantId, [apiDefId])).at(0);
    if (pending === undefined) return null;
    const row = await prisma.specCandidate.findFirst({ where: { id: pending.id, tenantId, apiDefId }, select: summarySelect });
    return row ? toSummary(row) : null;
  }

  /** `GET /apis/:id/spec-candidates`: the pending one (derived rule) and the rest, newest first. */
  async list(tenantId: string, apiDefId: string): Promise<{ pending: Candidate | null; history: CandidateSummary[] }> {
    await this.assertApi(tenantId, apiDefId);
    await this.settleStale(tenantId, apiDefId);
    const [pendingId] = (await pendingSpecCandidates(tenantId, [apiDefId])).map((c) => c.id);
    const rows = await prisma.specCandidate.findMany({
      where: { tenantId, apiDefId },
      orderBy: { detectedAt: 'desc' },
      take: CANDIDATE_RETENTION,
      select: { ...summarySelect, format: true, openapiVersion: true, findings: true },
    });
    const pendingRow = rows.find((row) => row.id === pendingId);
    return {
      pending: pendingRow
        ? {
            ...toSummary(pendingRow),
            format: pendingRow.format,
            openapiVersion: pendingRow.openapiVersion,
            findings: Array.isArray(pendingRow.findings) ? (pendingRow.findings as unknown as LintFinding[]) : [],
          }
        : null,
      // A PENDING row that is not the displayed one is moot (a race with settleStale): shown as such.
      history: rows
        .filter((row) => row.id !== pendingId)
        .map((row) => ({ ...toSummary(row), ...(row.state === 'PENDING' ? { state: 'SUPERSEDED' as const } : {}) })),
    };
  }

  /**
   * `GET …/:cid/diff`: the OAS-04 dry run of the candidate's text against the CURRENT latest version —
   * never the stored summary, which may be stale (governance or the spec moved since detection).
   * Its `versionNo` is what the apply must send as `expectedVersion`.
   */
  async diff(tenantId: string, apiDefId: string, candidateId: string): Promise<SpecUpdateResult> {
    const text = await this.pendingText(tenantId, apiDefId, candidateId);
    const latest = await prisma.apiSpec.findFirst({
      where: { tenantId, apiDefId },
      orderBy: { versionNo: 'desc' },
      select: { versionNo: true },
    });
    return this.specUpdate.update(text, tenantId, apiDefId, {
      dryRun: true,
      expectedVersion: latest?.versionNo ?? 0,
      acknowledgeRemoved: false,
    });
  }

  /**
   * `POST …/:cid/apply`: OAS-04's apply with the version the user reviewed. The candidate is marked
   * APPLIED inside the same transaction; if it stopped being PENDING meanwhile, the apply rolls back.
   */
  async apply(
    tenantId: string,
    apiDefId: string,
    candidateId: string,
    options: { expectedVersion: number; acknowledgeRemoved: boolean; userId?: string },
  ): Promise<SpecUpdateResult> {
    const text = await this.pendingText(tenantId, apiDefId, candidateId);
    const result = await this.specUpdate.update(text, tenantId, apiDefId, {
      dryRun: false,
      expectedVersion: options.expectedVersion,
      acknowledgeRemoved: options.acknowledgeRemoved,
      onApplied: async (tx) => {
        const marked = await tx.specCandidate.updateMany({
          where: { id: candidateId, tenantId, apiDefId, state: 'PENDING' },
          data: decided('APPLIED', await dbNow(tx), options.userId),
        });
        if (marked.count === 0) throw candidateStale();
      },
    });
    if (result.unchanged) {
      // Already the latest version (uploaded by hand): nothing was written, the proposal is moot.
      await prisma.specCandidate.updateMany({
        where: { id: candidateId, tenantId, apiDefId, state: 'PENDING' },
        data: decided('APPLIED', await dbNow(), options.userId),
      });
    }
    return result;
  }

  async dismiss(tenantId: string, apiDefId: string, candidateId: string, userId?: string): Promise<{ state: 'DISMISSED' }> {
    const marked = await prisma.specCandidate.updateMany({
      where: { id: candidateId, tenantId, apiDefId, state: 'PENDING' },
      data: decided('DISMISSED', await dbNow(), userId),
    });
    if (marked.count === 0) {
      await this.pendingText(tenantId, apiDefId, candidateId); // 404 or 409, whichever is true
      throw candidateStale();
    }
    return { state: 'DISMISSED' };
  }

  /** `GET /spec-updates`: every API of the tenant with a pending proposal, newest first, ≤ 100. */
  async pendingUpdates(tenantId: string): Promise<{ items: SpecUpdateItem[] }> {
    const ids = (await pendingSpecCandidates(tenantId)).map((c) => c.id);
    if (ids.length === 0) return { items: [] };
    const rows = await prisma.specCandidate.findMany({
      where: { tenantId, id: { in: ids } },
      orderBy: { detectedAt: 'desc' },
      select: { ...summarySelect, apiDef: { select: { id: true, name: true } } },
    });
    return {
      items: rows.map((row) => ({
        apiId: row.apiDef.id,
        apiName: row.apiDef.name,
        candidateId: row.id,
        detectedAt: row.detectedAt,
        diff: toSummary(row).diff,
      })),
    };
  }

  private async assertApi(tenantId: string, apiDefId: string): Promise<void> {
    const api = await prisma.apiDefinition.findFirst({ where: { id: apiDefId, tenantId }, select: { id: true } });
    if (!api) throw new NotFoundException('API definition not found');
  }

  /** The text of a PENDING candidate of this tenant's API: 404 when absent, 409 when decided. */
  private async pendingText(tenantId: string, apiDefId: string, candidateId: string): Promise<string> {
    const row = await prisma.specCandidate.findFirst({
      where: { id: candidateId, tenantId, apiDefId },
      select: { state: true, sourceText: true },
    });
    if (!row) throw new NotFoundException('Spec candidate not found');
    if (row.state !== 'PENDING' || row.sourceText === null) throw candidateStale();
    return row.sourceText;
  }
}
