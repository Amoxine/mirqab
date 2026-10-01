import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type { ImportOptions, ImportPreview, ImportResult, LintFinding, SpecUpdateResult } from '@/lib/api/openapi';

/**
 * OAS-08c: the web side of "OpenAPI from a URL" (spec source, detected candidates, notifications,
 * import from a URL). Every response type of those routes lives in this one module (contract
 * `.omc/handoffs/oas08-contract.md` §2 + REV 2), so a wire-format change is adjusted in one place.
 * The URL itself is only ever sent in a JSON body, never in a query string, a toast or a log line;
 * the API returns it redacted (`https://host/…`).
 */

/** The only check intervals the API accepts (`PUT /apis/:id/spec-source`). */
export const SPEC_INTERVALS = [15, 60, 360, 1440] as const;
export type SpecInterval = (typeof SPEC_INTERVALS)[number];
export const DEFAULT_INTERVAL: SpecInterval = 60;
export const MAX_SPEC_URL_LENGTH = 2048;

export type SpecCheckResult = 'UNCHANGED' | 'CHANGED' | 'ERROR';

export type SpecSourceStatus =
  | { configured: false }
  | {
      configured: true;
      /** Redacted by the API: scheme and host only. */
      url: string;
      enabled: boolean;
      intervalMinutes: number;
      lastCheckedAt: string | null;
      lastSuccessAt: string | null;
      nextCheckAt: string | null;
      lastResult: SpecCheckResult | null;
      lastErrorCode: string | null;
      consecutiveFailures: number;
    };

export interface DiffCounts {
  added: number;
  removed: number;
  changed: number;
  governedRemoved: number;
  governedChanged: number;
}

export interface CandidateSummary {
  id: string;
  contentHash: string;
  state: 'PENDING' | 'APPLIED' | 'DISMISSED' | 'SUPERSEDED';
  detectedAt: string;
  decidedAt: string | null;
  endpointCount: number;
  baseVersionNo: number;
  /** Stored at detection time: a summary for the banner, never what an apply will do (see the diff route). */
  diff: DiffCounts;
}

export interface Candidate extends CandidateSummary {
  format: string;
  openapiVersion: string;
  findings: LintFinding[];
}

export interface SpecCandidates {
  pending: Candidate | null;
  history: CandidateSummary[];
}

export interface CheckOutcome {
  result: SpecCheckResult;
  errorCode?: string;
  candidate?: CandidateSummary;
}

export interface SpecUpdateItem {
  apiId: string;
  apiName: string;
  candidateId: string;
  detectedAt: string;
  diff: DiffCounts;
}

export interface SpecSourceBody {
  /** Omitted on edit = keep the stored URL. */
  url?: string;
  intervalMinutes: SpecInterval;
  enabled: boolean;
}

export interface UrlImportOptions extends ImportOptions {
  watch?: boolean;
  intervalMinutes?: SpecInterval;
}

/** The fixed codes the fetcher/checker report, with or without the `SPEC_FETCH_` prefix of a 422. */
const FETCH_CODES = new Set([
  'BAD_URL',
  'BLOCKED_TARGET',
  'UNREACHABLE',
  'TIMEOUT',
  'TOO_LARGE',
  'TOO_MANY_REDIRECTS',
  'NOT_A_SPEC',
  // A check that failed for a reason of its own (not the fetch); the scheduler retries it.
  'CHECK_FAILED',
]);

/**
 * A fetch/check error code as a `specSource.errors.*` key and its values. `DNS_FAILED` (an older
 * spelling) reads as `BLOCKED_TARGET`, as the API now reports it; an unknown code gets the generic text.
 */
export function fetchErrorKey(code: string | null | undefined): { key: string; values?: { status: number } } {
  const bare = (code ?? '').replace(/^SPEC_FETCH_/, '');
  const http = /^HTTP_(\d{3})$/.exec(bare);
  if (http) return { key: 'errors.HTTP', values: { status: Number(http[1]) } };
  if (bare === 'DNS_FAILED') return { key: 'errors.BLOCKED_TARGET' };
  return FETCH_CODES.has(bare) ? { key: `errors.${bare}` } : { key: 'errors.unknown' };
}

/** Codes of this feature that have their own `specSource.errors.*` text. */
const OWN_CODES = new Set([
  'SPEC_CHECK_COOLDOWN',
  'SPEC_VERSION_STALE',
  'SPEC_REMOVES_GOVERNED_ENDPOINTS',
  'SPEC_GOVERNANCE_CHANGED',
  'CANDIDATE_STALE',
  'SPEC_SOURCE_LIMIT',
  'SPEC_SOURCE_URL_REQUIRED',
  'SPEC_SOURCE_CHANGED',
  // The OAS-04 gates, run on what the URL served (diff, apply, import from a URL).
  'OAS_LINT_FAILED',
  'OAS_IMPORT_TOO_MANY_ENDPOINTS',
  'OAS_IMPORT_UNPARSEABLE',
  'OAS_IMPORT_UNSAFE_YAML',
  'OAS_IMPORT_UNSUPPORTED_VERSION',
  'OAS_IMPORT_UNUSABLE',
]);

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * An error of these routes as translated text only (`t` = the `specSource` namespace). The server's
 * message is never shown: it adds nothing to a fixed code, and a validation echo could carry the URL.
 */
export function specErrorMessage(t: Translate, error: unknown, fallbackKey: string): string {
  const known = knownSpecError(t, error);
  if (known) return known;
  if (error instanceof ApiRequestError && error.status === 403) return t('errors.forbidden');
  if (error instanceof ApiRequestError && error.status === 404) return t('errors.notFound');
  return t(fallbackKey);
}

/** The text of a code this feature translates itself, or null for any other failure. */
export function knownSpecError(t: Translate, error: unknown): string | null {
  const code = error instanceof ApiRequestError ? error.code : undefined;
  if (code?.startsWith('SPEC_FETCH_')) {
    const { key, values } = fetchErrorKey(code);
    return t(key, values);
  }
  return code && OWN_CODES.has(code) ? t(`errors.${code}`) : null;
}

export const isSpecFetchError = (error: unknown): boolean =>
  error instanceof ApiRequestError && (error.code?.startsWith('SPEC_FETCH_') ?? false);

/** A diff/apply answer that means "what you reviewed is no longer current": re-diff. */
export const isReviewStale = (error: unknown): boolean => error instanceof ApiRequestError && error.status === 409;

const POLL_MS = 60_000;
const pollUnlessFailed = (query: { state: { status: string } }) => (query.state.status === 'error' ? false : POLL_MS);

/** Everything a check/apply/dismiss changes for one API: its source, candidates, spec and the tenant-wide list. */
function invalidateApi(qc: ReturnType<typeof useQueryClient>, apiId: string, specChanged = false) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: specChanged ? queryKeys.apis.detail(apiId) : queryKeys.apis.specSource(apiId) }),
    qc.invalidateQueries({ queryKey: queryKeys.apis.specCandidates(apiId) }),
    qc.invalidateQueries({ queryKey: queryKeys.apis.specUpdates }),
  ]);
}

export function useSpecSource(apiId: string) {
  return useQuery({
    queryKey: queryKeys.apis.specSource(apiId),
    queryFn: () => api.get<SpecSourceStatus>(`/apis/${apiId}/spec-source`).then((res) => res.data),
    enabled: !!apiId,
    // The scheduler may check while the page is open: poll only a configured source, never after an
    // error (a retry button refetches), and never in a hidden tab (`refetchIntervalInBackground` false).
    refetchInterval: (query) => (query.state.status !== 'error' && query.state.data?.configured === true ? POLL_MS : false),
  });
}

/** Only an API that watches a URL has candidates to show (`enabled` = its source is configured). */
export function useSpecCandidates(apiId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.apis.specCandidates(apiId),
    queryFn: () => api.get<SpecCandidates>(`/apis/${apiId}/spec-candidates`).then((res) => res.data),
    enabled: !!apiId && enabled,
    refetchInterval: pollUnlessFailed,
  });
}

/** Recomputed by the API against the CURRENT stored version; its `versionNo` is what an apply compare-and-sets. */
export function useCandidateDiff(apiId: string, candidateId: string | null) {
  return useQuery({
    queryKey: queryKeys.apis.candidateDiff(apiId, candidateId ?? ''),
    queryFn: () =>
      api.get<SpecUpdateResult>(`/apis/${apiId}/spec-candidates/${candidateId ?? ''}/diff`).then((res) => res.data),
    enabled: !!apiId && !!candidateId,
    // A review must be of what the API says now, not of a cached answer.
    staleTime: 0,
    gcTime: 0,
    retry: (count, error) => !(error instanceof ApiRequestError && error.status < 500) && count < 2,
  });
}

/** Pending updates of the tenant (≤ 100), for the dashboard card. The API list reads `specUpdateAvailable` per row. */
export function useSpecUpdates(enabled = true) {
  return useQuery({
    queryKey: queryKeys.apis.specUpdates,
    queryFn: () => api.get<{ items: SpecUpdateItem[] }>('/spec-updates').then((res) => res.data.items),
    refetchInterval: pollUnlessFailed,
    enabled,
  });
}

export function useSaveSpecSource(apiId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SpecSourceBody) => api.put<SpecSourceStatus>(`/apis/${apiId}/spec-source`, body).then((res) => res.data),
    onSuccess: () => invalidateApi(qc, apiId),
  });
}

export function useRemoveSpecSource(apiId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ removed: boolean }>(`/apis/${apiId}/spec-source`).then((res) => res.data),
    onSuccess: () => invalidateApi(qc, apiId),
  });
}

export function useCheckSpecSource(apiId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<CheckOutcome>(`/apis/${apiId}/spec-source/check`, {}).then((res) => res.data),
    // A refused check (cooldown) changed nothing; any answer did update the status line.
    onSuccess: () => invalidateApi(qc, apiId),
  });
}

export function useApplyCandidate(apiId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ candidateId, expectedVersion, acknowledgeRemoved }: { candidateId: string; expectedVersion: number; acknowledgeRemoved: boolean }) => {
      const params = new URLSearchParams({ expectedVersion: String(expectedVersion) });
      if (acknowledgeRemoved) params.set('acknowledgeRemoved', 'true');
      return api
        .post<SpecUpdateResult>(`/apis/${apiId}/spec-candidates/${candidateId}/apply?${params.toString()}`, {})
        .then((res) => res.data);
    },
    // `detail` covers the endpoints, source and candidate keys of this API.
    onSuccess: () => invalidateApi(qc, apiId, true),
    // The stored spec or its governance moved: reload what the page shows too, not only the diff.
    onError: (error) => (isReviewStale(error) ? invalidateApi(qc, apiId, true) : undefined),
  });
}

export function useDismissCandidate(apiId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (candidateId: string) =>
      api.post<{ state: 'DISMISSED' }>(`/apis/${apiId}/spec-candidates/${candidateId}/dismiss`, {}).then((res) => res.data),
    onSuccess: () => invalidateApi(qc, apiId),
  });
}

const urlImportBody = (url: string, { slug, serverIndex, watch, intervalMinutes }: UrlImportOptions) => ({
  url,
  ...(slug ? { slug } : {}),
  ...(serverIndex !== undefined ? { serverIndex } : {}),
  ...(watch ? { watch: true, intervalMinutes: intervalMinutes ?? DEFAULT_INTERVAL } : {}),
});

/** The API fetches the URL server-side, then runs the same gates as `POST /apis/import/preview`. */
export const previewImportUrl = (url: string, options: ImportOptions) =>
  api.post<ImportPreview>('/apis/import/url/preview', urlImportBody(url, options)).then((res) => res.data);

export function useImportUrl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ url, options }: { url: string; options: UrlImportOptions }) =>
      api.post<ImportResult>('/apis/import/url', urlImportBody(url, options)).then((res) => res.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.apis.all }),
  });
}

/**
 * Client-side shape check before a request: http(s), a host, ≤ 2048 characters and no `user:password@`
 * (Basic-auth-protected specs are not supported). Returns a `specSource.url.*` key, or null when fine.
 * The API applies the real policy (address resolution, allow-list) and answers a fixed code.
 */
export function specUrlProblem(value: string): string | null {
  const v = value.trim();
  if (v === '') return 'url.required';
  if (v.length > MAX_SPEC_URL_LENGTH) return 'url.tooLong';
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return 'url.invalid';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'url.scheme';
  if (parsed.username !== '' || parsed.password !== '') return 'url.userinfo';
  if (parsed.hostname === '') return 'url.invalid';
  return null;
}
