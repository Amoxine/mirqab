import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { prisma } from '@open-gateway/database';
import type { ApiSpecSource, Prisma } from '@prisma/client';
import {
  SPEC_FETCHER,
  SpecFetchError,
  redactSpecUrl,
  type SpecFetchOk,
  type SpecFetcherPort,
} from '../../spec-fetch/spec-fetch.types';
import { parseSpecUrl } from '../../spec-fetch/spec-url-policy';
import {
  dbNow,
  SpecCandidateService,
  type CandidateSummary,
  type CheckResult,
  type Detection,
  type DetectionAbort,
} from './spec-candidate.service';

export const SPEC_SOURCE_INTERVALS = [15, 60, 360, 1440] as const;
export type SpecSourceInterval = (typeof SPEC_SOURCE_INTERVALS)[number];
export const MAX_SOURCES_PER_TENANT = 50;
export const CHECK_COOLDOWN_MS = 30_000;
const MAX_BACKOFF_MINUTES = 1440;
const MINUTE = 60_000;

export type SpecSourceView =
  | { configured: false }
  | {
      configured: true;
      /** `https://host/…`: the stored URL may carry a secret in its query string. */
      url: string;
      enabled: boolean;
      intervalMinutes: number;
      lastCheckedAt: Date | null;
      lastSuccessAt: Date | null;
      nextCheckAt: Date;
      lastResult: CheckResult | null;
      lastErrorCode: string | null;
      consecutiveFailures: number;
    };

export interface CheckOutcome {
  result: CheckResult;
  errorCode?: string;
  candidate?: CandidateSummary;
}

export interface PutSpecSource {
  url?: string;
  intervalMinutes: SpecSourceInterval;
  enabled?: boolean;
}

const toView = (row: ApiSpecSource): SpecSourceView => ({
  configured: true,
  url: redactSpecUrl(row.url),
  enabled: row.enabled,
  intervalMinutes: row.intervalMinutes,
  lastCheckedAt: row.lastCheckedAt,
  lastSuccessAt: row.lastSuccessAt,
  nextCheckAt: row.nextCheckAt,
  lastResult: row.lastResult as CheckResult | null,
  lastErrorCode: row.lastErrorCode,
  consecutiveFailures: row.consecutiveFailures,
});

/** The fetcher's fixed code as an HTTP answer. Its message is fixed too: never the URL or remote text. */
export function specFetchHttpError(err: unknown): unknown {
  return err instanceof SpecFetchError
    ? new UnprocessableEntityException({ message: err.message, error: `SPEC_FETCH_${err.code}` })
    : err;
}

/** Up to 10 % of the interval, at most 5 minutes: two sources set up together drift apart. */
const jitterMs = (intervalMinutes: number): number => Math.floor(Math.random() * Math.min(intervalMinutes * 6_000, 300_000));

/** The next check after `failures` consecutive failures (≥ 1): the interval doubled each time, capped at 24 h. */
export function backoffMinutes(intervalMinutes: number, failures: number): number {
  return Math.min(intervalMinutes * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MINUTES);
}

/**
 * The URL as the fetcher will read it (`new URL()`: trimmed, `https:h` → `https://h/`, backslashes →
 * slashes, lower-case scheme and host). Stored and compared in this form, so two spellings of one URL
 * are one URL. A string the fetcher would refuse to parse is 422 SPEC_FETCH_BAD_URL.
 */
export function normaliseSpecUrl(url: string): string {
  try {
    return parseSpecUrl(url).href;
  } catch (err) {
    throw specFetchHttpError(err);
  }
}

const sourceChanged = (): ConflictException =>
  new ConflictException({
    message: 'The spec URL was changed while it was being checked. Check again.',
    error: 'SPEC_SOURCE_CHANGED',
  });

/**
 * OAS-08: the URL an API's spec is watched at, and one check of it. The check is claimed first (a
 * compare-and-set that also advances `next_check_at`), so a second replica, the scheduler and "check
 * now" never check the same source twice at once, and a crash mid-check retries at the next interval.
 * The URL is never logged: log lines name the source id.
 */
@Injectable()
export class SpecSourceService {
  private readonly logger = new Logger(SpecSourceService.name);

  constructor(
    @Inject(SPEC_FETCHER) private readonly fetcher: SpecFetcherPort,
    private readonly candidates: SpecCandidateService,
  ) {}

  async get(tenantId: string, apiDefId: string): Promise<SpecSourceView> {
    await this.assertApi(tenantId, apiDefId);
    const row = await prisma.apiSpecSource.findFirst({ where: { apiDefId, tenantId } });
    return row ? toView(row) : { configured: false };
  }

  /** `url` may be omitted on an edit (the stored one is kept); changing it forgets everything learnt about the old one. */
  async put(tenantId: string, apiDefId: string, input: PutSpecSource): Promise<SpecSourceView> {
    await this.assertApi(tenantId, apiDefId);
    const url = input.url === undefined ? undefined : normaliseSpecUrl(input.url);
    if (url !== undefined) await this.validate(url);
    const now = await dbNow();

    return toView(
      await prisma.$transaction(async (tx) => {
        const existing = await tx.apiSpecSource.findFirst({ where: { apiDefId, tenantId } });
        if (!existing) {
          if (url === undefined) {
            throw new BadRequestException({ message: 'url is required to set up a spec source', error: 'SPEC_SOURCE_URL_REQUIRED' });
          }
          await this.assertCapacity(tenantId, tx);
          return tx.apiSpecSource.create({
            data: { tenantId, apiDefId, url, intervalMinutes: input.intervalMinutes, enabled: input.enabled ?? true, nextCheckAt: now },
          });
        }
        const urlChanged = url !== undefined && url !== existing.url;
        const reEnabled = input.enabled === true && !existing.enabled;
        return tx.apiSpecSource.update({
          where: { id: existing.id },
          data: {
            intervalMinutes: input.intervalMinutes,
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            // Only a new URL or a re-enable makes it due now: a no-op PUT must not bypass the cooldown
            // (and start a second check of a source already being checked).
            ...(urlChanged || reEnabled ? { nextCheckAt: now } : {}),
            ...(urlChanged ? { url, etag: null, lastModified: null, lastResult: null, lastErrorCode: null, consecutiveFailures: 0 } : {}),
          },
        });
      }),
    );
  }

  /** Removing the source withdraws its pending proposal (SUPERSEDED): nothing watches that URL any more. */
  async remove(tenantId: string, apiDefId: string): Promise<{ removed: true }> {
    await prisma.$transaction(async (tx) => {
      const deleted = await tx.apiSpecSource.deleteMany({ where: { apiDefId, tenantId } });
      if (deleted.count === 0) throw new NotFoundException('No spec source is configured for this API');
      await this.candidates.supersedePending(tenantId, apiDefId, tx);
    });
    return { removed: true };
  }

  /**
   * "Check now": the same claim as the scheduler, conditioned on `last_checked_at` being older than
   * 30 s by the database clock — the cooldown holds across replicas and restarts.
   */
  async checkNow(tenantId: string, apiDefId: string): Promise<CheckOutcome> {
    const source = await prisma.apiSpecSource.findFirst({ where: { apiDefId, tenantId } });
    if (!source) throw new NotFoundException('No spec source is configured for this API');
    const now = await dbNow();
    const claimed = await prisma.apiSpecSource.updateMany({
      where: {
        id: source.id,
        tenantId,
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: new Date(now.getTime() - CHECK_COOLDOWN_MS) } }],
      },
      data: { lastCheckedAt: now, nextCheckAt: new Date(now.getTime() + source.intervalMinutes * MINUTE + jitterMs(source.intervalMinutes)) },
    });
    if (claimed.count === 0) {
      throw new HttpException(
        { message: 'This spec URL was checked less than 30 seconds ago. Try again shortly.', error: 'SPEC_CHECK_COOLDOWN' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const outcome = await this.check(source, now);
    if (outcome === 'GONE') throw new NotFoundException('No spec source is configured for this API');
    if (outcome === 'SOURCE_CHANGED') throw sourceChanged();
    return outcome;
  }

  /** Enabled sources whose `next_check_at` has passed on the database clock, oldest first. */
  async due(limit: number): Promise<{ now: Date; sources: ApiSpecSource[] }> {
    const now = await dbNow();
    const sources = await prisma.apiSpecSource.findMany({
      where: { enabled: true, nextCheckAt: { lte: now } },
      orderBy: { nextCheckAt: 'asc' },
      take: limit,
    });
    return { now, sources };
  }

  /** The scheduler's claim: 0 rows means another replica (or "check now") took it — skipped. */
  async claimAndCheck(source: ApiSpecSource): Promise<CheckOutcome | null> {
    const now = await dbNow();
    const claimed = await prisma.apiSpecSource.updateMany({
      where: { id: source.id, enabled: true, nextCheckAt: source.nextCheckAt },
      data: { lastCheckedAt: now, nextCheckAt: new Date(now.getTime() + source.intervalMinutes * MINUTE + jitterMs(source.intervalMinutes)) },
    });
    if (claimed.count === 0) return null;
    const outcome = await this.check(source, now);
    return typeof outcome === 'string' ? null : outcome;
  }

  /** `POST /apis/import/url*`: the document at a URL, through the guarded fetcher. */
  async fetchDocument(url: string): Promise<SpecFetchOk> {
    try {
      const fetched = await this.fetcher.fetch(url);
      // No validators were sent, so a 304 is the remote misbehaving; treat it like any other refusal.
      if (fetched.kind === 'NOT_MODIFIED') throw new SpecFetchError('HTTP_304');
      return fetched;
    } catch (err) {
      throw specFetchHttpError(err);
    }
  }

  /** Before an import with `watch: true`, so a refused source does not leave a created API behind. */
  async assertCapacity(tenantId: string, tx: Prisma.TransactionClient = prisma): Promise<void> {
    // ponytail: count-then-insert; two concurrent writes can overshoot by one (stated in the docs).
    if ((await tx.apiSpecSource.count({ where: { tenantId } })) >= MAX_SOURCES_PER_TENANT) {
      throw new BadRequestException({
        message: `A tenant can watch at most ${String(MAX_SOURCES_PER_TENANT)} spec URLs`,
        error: 'SPEC_SOURCE_LIMIT',
      });
    }
  }

  /** The source an import from a URL leaves behind: the document it imported is the one just checked. */
  async createWatched(
    tenantId: string,
    apiDefId: string,
    url: string,
    intervalMinutes: SpecSourceInterval,
    fetched: Pick<SpecFetchOk, 'etag' | 'lastModified'>,
  ): Promise<SpecSourceView> {
    const now = await dbNow();
    return toView(
      await prisma.apiSpecSource.create({
        data: {
          tenantId,
          apiDefId,
          url: normaliseSpecUrl(url),
          intervalMinutes,
          etag: fetched.etag,
          lastModified: fetched.lastModified,
          lastCheckedAt: now,
          lastSuccessAt: now,
          lastResult: 'UNCHANGED',
          nextCheckAt: new Date(now.getTime() + intervalMinutes * MINUTE + jitterMs(intervalMinutes)),
        },
      }),
    );
  }

  /** One claimed check. A string: the source was removed, or its URL edited, meanwhile (dropped). */
  private async check(source: ApiSpecSource, claimedAt: Date): Promise<CheckOutcome | DetectionAbort> {
    let detection: Detection | DetectionAbort;
    let validators: Pick<SpecFetchOk, 'etag' | 'lastModified'> | undefined;
    try {
      const fetched = await this.fetcher.fetch(source.url, { etag: source.etag, lastModified: source.lastModified });
      if (fetched.kind === 'NOT_MODIFIED') {
        // A 304 never reaches detect: tidy a proposal a manual upload made moot here.
        await this.candidates.settleStale(source.tenantId, source.apiDefId);
        // Unchanged since the last look — but an update detected then may still be waiting: say so.
        const waiting = await this.candidates.waiting(source.tenantId, source.apiDefId);
        detection = waiting ? { result: 'CHANGED', candidate: waiting } : { result: 'UNCHANGED' };
      } else {
        detection = await this.candidates.detect(source.tenantId, source.apiDefId, fetched.text, source.url);
        validators = { etag: fetched.etag, lastModified: fetched.lastModified };
      }
    } catch (err) {
      // Anything else (a version applied mid-check, a lint crash, the database) is recorded too, with a
      // fixed code: a source that silently never concludes would look healthy. Name only in the log.
      if (!(err instanceof SpecFetchError)) {
        this.logger.warn(`Spec source ${source.id} check failed: ${err instanceof Error ? err.name : 'unknown error'}`);
      }
      detection = { result: 'ERROR', errorCode: err instanceof SpecFetchError ? `SPEC_FETCH_${err.code}` : 'CHECK_FAILED' };
    }
    if (typeof detection === 'string') return detection;

    const failed = detection.result === 'ERROR';
    const failures = failed ? source.consecutiveFailures + 1 : 0;
    const data: Prisma.ApiSpecSourceUpdateManyMutationInput = {
      lastResult: detection.result,
      lastErrorCode: failed ? (detection.errorCode ?? null) : null,
      consecutiveFailures: failures,
      // Validators only once the gates passed: after NOT_A_SPEC the old ones stay, so the next check
      // re-fetches instead of a 304 masking the error.
      ...(failed ? {} : { lastSuccessAt: await dbNow(), ...(validators ?? {}) }),
      ...(failures > 1
        ? { nextCheckAt: new Date(claimedAt.getTime() + backoffMinutes(source.intervalMinutes, failures) * MINUTE) }
        : {}),
    };
    // Guarded on the URL: an edit that changed it during the check must not inherit this answer.
    const written = await prisma.apiSpecSource.updateMany({ where: { id: source.id, tenantId: source.tenantId, url: source.url }, data });
    if (written.count === 0) {
      return (await prisma.apiSpecSource.count({ where: { id: source.id, tenantId: source.tenantId } })) > 0 ? 'SOURCE_CHANGED' : 'GONE';
    }
    if (failed) this.logger.warn(`Spec source ${source.id} check failed: ${detection.errorCode ?? 'ERROR'}`);
    return detection;
  }

  private async validate(url: string): Promise<void> {
    try {
      await this.fetcher.validateUrl(url);
    } catch (err) {
      throw specFetchHttpError(err);
    }
  }

  private async assertApi(tenantId: string, apiDefId: string): Promise<void> {
    const api = await prisma.apiDefinition.findFirst({ where: { id: apiDefId, tenantId }, select: { id: true } });
    if (!api) throw new NotFoundException('API definition not found');
  }
}
