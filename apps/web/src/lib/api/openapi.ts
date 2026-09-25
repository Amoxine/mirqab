import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiRequestError } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type { ApiDetail } from '@/hooks/use-apis';
import type { ApiSyncStatus } from '@/types';

/**
 * OAS-05: the web side of OpenAPI import, endpoint governance and spec re-upload. Every response
 * type the UI reads from those routes lives in this one module (contract `.omc/handoffs/oas-contract.md`
 * §2-4, `docs/OAS-IMPORT.md`), so a change in the API's wire format is adjusted in one place.
 */

/** Largest document the API accepts (`MAX_SPEC_BYTES`); checked client-side too so a 6 MB paste fails fast. */
export const MAX_SPEC_BYTES = 5 * 1024 * 1024;

export interface LintFinding {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  path: string;
  line: number;
}

export interface EndpointRow {
  key: string;
  method: string;
  path: string;
  operationId: string | null;
  summary: string | null;
  tags: string[];
  deprecated: boolean;
  securitySchemes: string[];
  /** OAS-04; absent/null on rows stored before it. */
  fingerprint?: string | null;
}

export interface EndpointGovernance {
  enabled?: false;
  auth?: 'public';
  rateLimit?: { rate: number; per: number };
  cache?: { timeoutSeconds: number; cacheResponseCodes?: number[] };
  timeoutSeconds?: number;
  requestSizeLimitBytes?: number;
  mock?: { code: number; body: string; headers?: { name: string; value: string }[] };
  validateRequestSchema?: Record<string, unknown>;
}

export type GovernanceControl = keyof EndpointGovernance;

/** Input of `set`: `enabled: true` / `auth: 'inherit'` mean "clear" and are accepted by the API. */
export type EndpointGovernanceInput = Omit<EndpointGovernance, 'enabled' | 'auth'> & {
  enabled?: boolean;
  auth?: 'public' | 'inherit';
};

export type CapabilityStatus = 'enforced' | 'enforced-with-prerequisite' | 'unverified';

export interface EndpointCapability {
  control: string;
  status: CapabilityStatus;
  prerequisite?: string;
  behaviour: string;
}

export interface GovernedEndpoint extends EndpointRow {
  governance: EndpointGovernance | null;
}

/** `GET /apis/:id/endpoints` (and the `PATCH` answer). */
export interface EndpointGovernanceList {
  versionNo: number;
  contentHash: string;
  format: string;
  openapiVersion: string;
  endpointCount: number;
  createdAt: string;
  endpoints: GovernedEndpoint[];
  orphans: { key: string; governance: EndpointGovernance }[];
  restrictToSpec: boolean;
  revision: string;
  syncStatus: ApiSyncStatus;
  syncError: string | null;
  capabilities: EndpointCapability[];
}

export interface UpdateEndpointsBody {
  expectedRevision: string;
  keys?: string[];
  tag?: string;
  set?: EndpointGovernanceInput;
  clear?: GovernanceControl[];
  restrictToSpec?: boolean;
  dropOrphans?: boolean;
}

/** `POST /apis/import/preview`. */
export interface ImportPreview {
  valid: boolean;
  canImport: boolean;
  findings: LintFinding[];
  problems: Record<string, string[]>;
  openapiVersion: string;
  contentHash: string;
  format: 'json' | 'yaml';
  derived: { name: string; slug: string; listenPath: string; proxyUrl: string };
  servers: { index: number; url: string | null; selected: boolean; denyReason: string | null }[];
  conflicts: { slug: boolean; listenPath: boolean };
  endpointCount: number;
  endpoints: EndpointRow[];
}

/** `POST /apis/import` (201). */
export interface ImportResult {
  api: ApiDetail;
  findings: LintFinding[];
  spec: { versionNo: number; contentHash: string; endpointCount: number };
}

export interface ImportOptions {
  slug?: string;
  /** Only once the user picked a server: a document without `servers` must not get an index. */
  serverIndex?: number;
}

/** `POST /apis/:id/spec` (OAS-04). */
export interface SpecUpdateResult {
  dryRun: boolean;
  applied: boolean;
  unchanged: boolean;
  versionNo: number;
  findings: LintFinding[];
  diff: {
    added: EndpointRow[];
    removed: EndpointRow[];
    changed: { key: string; before: EndpointRow; after: EndpointRow; fields: string[] }[];
  };
  governanceImpact: {
    removedGoverned: { key: string; governance: EndpointGovernance }[];
    changedGoverned: string[];
  };
}

/** Controls a surface may offer: the API reported them as proven on the pinned gateway. */
export const isOffered = (capabilities: readonly EndpointCapability[], control: string): boolean =>
  capabilities.some((c) => c.control === control && c.status !== 'unverified');

/** Only these methods take the control (the API refuses it elsewhere with 400). */
export const CONTROL_METHODS: Partial<Record<GovernanceControl, readonly string[]>> = {
  cache: ['GET'],
  validateRequestSchema: ['POST', 'PUT', 'PATCH'],
};

export const appliesTo = (control: GovernanceControl, method: string): boolean =>
  CONTROL_METHODS[control]?.includes(method.toUpperCase()) ?? true;

/**
 * ONE non-JSON type for every document, JSON or YAML. `application/json` would hand the body to Nest's
 * global JSON parser, which runs before the route's raw-text parser: the controller would get an
 * object (read as an empty document) and anything over 100 kB a 413. The API sniffs the format itself.
 */
export const SPEC_CONTENT_TYPE = 'text/plain; charset=utf-8';

export const specByteLength = (source: string): number => new TextEncoder().encode(source).length;

const importQuery = ({ slug, serverIndex }: ImportOptions): string => {
  const params = new URLSearchParams();
  if (slug) params.set('slug', slug);
  if (serverIndex !== undefined) params.set('serverIndex', String(serverIndex));
  const query = params.toString();
  return query ? `?${query}` : '';
};

export const previewImport = (source: string, options: ImportOptions) =>
  api
    .postRaw<ImportPreview>(`/apis/import/preview${importQuery(options)}`, source, SPEC_CONTENT_TYPE)
    .then((res) => res.data);

export const isNoSpec = (error: unknown) => error instanceof ApiRequestError && error.status === 404;
export const isStale = (error: unknown) => error instanceof ApiRequestError && error.status === 409;
/** The API's `error.code`, e.g. `ENDPOINT_REVISION_STALE`, `SPEC_VERSION_STALE`, `SPEC_REMOVES_GOVERNED_ENDPOINTS`. */
export const errorCode = (error: unknown): string | undefined => (error instanceof ApiRequestError ? error.code : undefined);
export const isForbidden = (error: unknown) => error instanceof ApiRequestError && error.status === 403;

/** While the sync is PENDING, re-read until it settles (same cadence as `use-apis.ts`). */
const SYNC_POLL_MS = 5000;

export function useEndpointGovernance(apiId: string) {
  return useQuery({
    queryKey: queryKeys.apis.endpoints(apiId),
    queryFn: () => api.get<EndpointGovernanceList>(`/apis/${apiId}/endpoints`).then((res) => res.data),
    enabled: !!apiId,
    // A 404 is "no stored spec", an answer, not a transient failure.
    retry: (count, error) => !isNoSpec(error) && !isForbidden(error) && count < 2,
    refetchInterval: (query) => (query.state.data?.syncStatus === 'PENDING' ? SYNC_POLL_MS : false),
  });
}

export function useUpdateEndpoints(apiId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateEndpointsBody) =>
      api.patch<EndpointGovernanceList>(`/apis/${apiId}/endpoints`, body).then((res) => res.data),
    onSuccess: (data) => {
      qc.setQueryData(queryKeys.apis.endpoints(apiId), data);
      // The API row's sync status changed too (PENDING); `detail` also covers the endpoints key.
      return qc.invalidateQueries({ queryKey: queryKeys.apis.detail(apiId), refetchType: 'active' });
    },
    onError: (error) => {
      // Stale revision: load what the other writer saved so the user re-decides on real state.
      if (isStale(error)) return qc.invalidateQueries({ queryKey: queryKeys.apis.endpoints(apiId) });
      return undefined;
    },
  });
}

export function useImportApi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ source, options }: { source: string; options: ImportOptions }) =>
      api
        .postRaw<ImportResult>(`/apis/import${importQuery(options)}`, source, SPEC_CONTENT_TYPE)
        .then((res) => res.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.apis.all }),
  });
}

export function useSpecUpdate(apiId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      source,
      expectedVersion,
      dryRun,
      acknowledgeRemoved,
    }: {
      source: string;
      expectedVersion: number;
      dryRun: boolean;
      acknowledgeRemoved?: boolean;
    }) => {
      // The dry run is its own route (writes nothing, not audited); the apply route takes no `dryRun`.
      // `expectedVersion=0` = the API has no stored spec yet: the apply creates version 1.
      const params = new URLSearchParams({ expectedVersion: String(expectedVersion) });
      if (!dryRun && acknowledgeRemoved) params.set('acknowledgeRemoved', 'true');
      const route = dryRun ? `/apis/${apiId}/spec/preview` : `/apis/${apiId}/spec`;
      return api
        .postRaw<SpecUpdateResult>(`${route}?${params.toString()}`, source, SPEC_CONTENT_TYPE)
        .then((res) => res.data);
    },
    onSuccess: (data) => {
      if (!data.applied) return undefined;
      return qc.invalidateQueries({ queryKey: queryKeys.apis.detail(apiId) });
    },
    onError: (error) => {
      if (isStale(error)) return qc.invalidateQueries({ queryKey: queryKeys.apis.endpoints(apiId) });
      return undefined;
    },
  });
}
