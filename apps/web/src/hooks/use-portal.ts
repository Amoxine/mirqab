import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { portalApi } from '@/lib/portal-api-client';

/**
 * Types below mirror the backend's own response shapes (`apps/api/src/modules/portal/**`,
 * `PortalCatalogController`'s `PortalApiDoc`) — hand-kept in sync, same as `use-apis.ts` already
 * does for the dashboard: the two apps share no types package.
 */

export interface CurrentDeveloper {
  id: string;
  email: string;
  name: string;
  tenantSlug: string;
}

export interface PortalProductApi {
  id: string;
  name: string;
  slug: string;
}

export interface PortalProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  apis: PortalProductApi[];
  createdAt: string;
  updatedAt: string;
}

export type QuotaPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface PortalPlan {
  id: string;
  name: string;
  description: string | null;
  rate: number;
  per: number;
  quotaMax: number;
  quotaPeriod: QuotaPeriod;
  active: boolean;
  keyCount: number;
  createdAt: string;
  updatedAt: string;
}

/** `GET /portal/catalog/apis/:id` — the generated OAS document plus the try-it console's target. */
export interface PortalApiDoc {
  id: string;
  name: string;
  authType: string;
  authHeaderName?: string;
  gatewayListenPath: string;
  oasDocument: Record<string, unknown> | null;
}

export interface PortalApplication {
  id: string;
  name: string;
  description: string | null;
  subscriptionCount: number;
  createdAt: string;
  updatedAt: string;
}

export type SubscriptionStatus = 'PENDING' | 'APPROVED' | 'REVOKED';

export interface PortalSubscription {
  id: string;
  applicationId: string;
  productId: string;
  productName: string;
  planId: string;
  planName: string;
  status: SubscriptionStatus;
  approvedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /** Only present the one time a key is minted — never stored, never re-shown. */
  keyValue?: string;
}

export const USAGE_RANGES = ['1h', '24h', '7d', '30d'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export interface PortalUsage {
  range: UsageRange;
  requests: number;
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
  quotaMax: number | null;
  quotaRemaining: number | null;
  quotaResetAt: string | null;
}

const portalKeys = {
  me: ['portal', 'me'] as const,
  products: ['portal', 'products'] as const,
  product: (id: string) => ['portal', 'products', id] as const,
  plans: ['portal', 'plans'] as const,
  api: (id: string) => ['portal', 'apis', id] as const,
  applications: ['portal', 'applications'] as const,
  subscriptions: (applicationId: string) => ['portal', 'applications', applicationId, 'subscriptions'] as const,
  usage: (applicationId: string, subscriptionId: string, range: string) =>
    ['portal', 'applications', applicationId, 'subscriptions', subscriptionId, 'usage', range] as const,
};

/** `enabled: false` lets a caller skip this until it actually needs to know (e.g. a page that
 * redirects unauthenticated visitors elsewhere first). A 401 here already redirects to login via
 * `portal-api-client.ts`, so most callers just want the loading/data/error triad. */
export function usePortalMe(enabled = true) {
  return useQuery({
    queryKey: portalKeys.me,
    queryFn: () => portalApi.get<CurrentDeveloper>('/portal/auth/me'),
    enabled,
    retry: false,
  });
}

export function usePortalProducts() {
  return useQuery({
    queryKey: portalKeys.products,
    queryFn: () => portalApi.get<PortalProduct[]>('/portal/catalog/products'),
  });
}

export function usePortalProduct(id: string) {
  return useQuery({
    queryKey: portalKeys.product(id),
    queryFn: () => portalApi.get<PortalProduct>(`/portal/catalog/products/${id}`),
    enabled: !!id,
  });
}

export function usePortalPlans() {
  return useQuery({
    queryKey: portalKeys.plans,
    queryFn: () => portalApi.get<PortalPlan[]>('/portal/catalog/plans'),
  });
}

export function usePortalApiDoc(id: string) {
  return useQuery({
    queryKey: portalKeys.api(id),
    queryFn: () => portalApi.get<PortalApiDoc>(`/portal/catalog/apis/${id}`),
    enabled: !!id,
  });
}

export function usePortalApplications() {
  return useQuery({
    queryKey: portalKeys.applications,
    queryFn: () => portalApi.get<PortalApplication[]>('/portal/applications'),
  });
}

function invalidateApplications(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: portalKeys.applications });
}

export function useCreatePortalApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      portalApi.post<PortalApplication>('/portal/applications', data),
    onSuccess: () => invalidateApplications(qc),
  });
}

export function usePortalSubscriptions(applicationId: string) {
  return useQuery({
    queryKey: portalKeys.subscriptions(applicationId),
    queryFn: () => portalApi.get<PortalSubscription[]>(`/portal/applications/${applicationId}/subscriptions`),
    enabled: !!applicationId,
  });
}

export function useCreatePortalSubscription(applicationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { productId: string; planId: string }) =>
      portalApi.post<PortalSubscription>(`/portal/applications/${applicationId}/subscriptions`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: portalKeys.subscriptions(applicationId) }),
  });
}

export function useRevokePortalSubscription(applicationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (subscriptionId: string) =>
      portalApi.post<PortalSubscription>(
        `/portal/applications/${applicationId}/subscriptions/${subscriptionId}/revoke`,
        {},
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: portalKeys.subscriptions(applicationId) }),
  });
}

export function usePortalUsage(applicationId: string, subscriptionId: string, range: UsageRange = '24h') {
  return useQuery({
    queryKey: portalKeys.usage(applicationId, subscriptionId, range),
    queryFn: () =>
      portalApi.get<PortalUsage>(
        `/portal/applications/${applicationId}/subscriptions/${subscriptionId}/usage?range=${range}`,
      ),
    enabled: !!applicationId && !!subscriptionId,
  });
}
