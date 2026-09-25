// Shared by the OAS-05 component tests (endpoints, import, spec-update) — not a test file itself.
import type { ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { vi } from 'vitest';
import enApis from '@/messages/en/apis.json';
import enCommon from '@/messages/en/common.json';
import enDashboard from '@/messages/en/dashboard.json';
import enOpenapi from '@/messages/en/openapi.json';
import enSpecSource from '@/messages/en/specSource.json';
import arApis from '@/messages/ar/apis.json';
import arCommon from '@/messages/ar/common.json';
import arDashboard from '@/messages/ar/dashboard.json';
import arOpenapi from '@/messages/ar/openapi.json';
import arSpecSource from '@/messages/ar/specSource.json';
import type { EndpointGovernanceList } from '@/lib/api/openapi';

const MESSAGES = {
  en: { apis: enApis, common: enCommon, dashboard: enDashboard, openapi: enOpenapi, specSource: enSpecSource },
  ar: { apis: arApis, common: arCommon, dashboard: arDashboard, openapi: arOpenapi, specSource: arSpecSource },
};

export function renderUi(
  ui: ReactNode,
  locale: 'en' | 'ar' = 'en',
): RenderResult & { client: QueryClient; rerenderUi: (next: ReactNode) => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
        <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>{node}</div>
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
  const result = render(wrap(ui));
  return {
    ...result,
    client,
    rerenderUi: (next) => {
      result.rerender(wrap(next));
    },
  };
}

export interface Call {
  method: string;
  path: string;
  body: string | undefined;
  contentType: string | null;
}

type Reply = { status: number; body?: unknown } | Promise<never>;

/**
 * Stubs `fetch` for the API client: `route(call)` answers each request. Every request is recorded
 * with its method, path (after `/api`), raw body and content type, which is what the tests assert on.
 */
export function mockFetch(route: (call: Call) => Reply) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/api/, '') + url.search,
      body: typeof init?.body === 'string' ? init.body : undefined,
      contentType: new Headers(init?.headers).get('Content-Type'),
    };
    calls.push(call);
    const reply = await route(call);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

export const ok = (data: unknown, status = 200) => ({ status, body: { success: true, data } });
export const fail = (status: number, message: string, code = 'ERR') => ({
  status,
  body: { success: false, error: { code, message } },
});
/** A request that never answers, for loading states. */
export const never = (): Promise<never> =>
  new Promise<never>(() => {
    /* pending forever */
  });

export const REVISION = 'a'.repeat(64);

export const CAPABILITIES: EndpointGovernanceList['capabilities'] = [
  { control: 'enabled', status: 'enforced', behaviour: 'answers 403' },
  { control: 'restrictToSpec', status: 'enforced', behaviour: 'allow-list' },
  { control: 'auth', status: 'enforced', behaviour: 'no key' },
  { control: 'rateLimit', status: 'enforced', behaviour: '429, shared' },
  { control: 'cache', status: 'enforced-with-prerequisite', prerequisite: 'global cache', behaviour: 'cached' },
  { control: 'validateRequestSchema', status: 'enforced', behaviour: '422' },
  { control: 'mock', status: 'enforced', behaviour: 'mocked' },
  { control: 'timeoutSeconds', status: 'enforced', behaviour: '504' },
  { control: 'requestSizeLimitBytes', status: 'enforced', behaviour: '400' },
  { control: 'circuitBreaker', status: 'unverified', behaviour: 'proven on the catch-all only' },
];

export const LIST: EndpointGovernanceList = {
  versionNo: 3,
  contentHash: 'h'.repeat(64),
  format: 'yaml',
  openapiVersion: '3.0.3',
  endpointCount: 2,
  createdAt: '2026-09-25T00:00:00.000Z',
  endpoints: [
    {
      key: 'listOrders',
      method: 'GET',
      path: '/orders',
      operationId: 'listOrders',
      summary: 'List orders',
      tags: ['orders'],
      deprecated: false,
      securitySchemes: [],
      governance: { rateLimit: { rate: 10, per: 60 } },
    },
    {
      key: 'createOrder',
      method: 'POST',
      path: '/orders/{id}',
      operationId: 'createOrder',
      summary: null,
      tags: ['admin'],
      deprecated: true,
      securitySchemes: [],
      governance: null,
    },
  ],
  orphans: [{ key: 'GET /legacy', governance: { enabled: false } }],
  restrictToSpec: false,
  revision: REVISION,
  syncStatus: 'SYNCED',
  syncError: null,
  capabilities: CAPABILITIES,
};

export const pendingList = (over: Partial<EndpointGovernanceList> = {}): EndpointGovernanceList => ({
  ...LIST,
  syncStatus: 'PENDING',
  revision: 'b'.repeat(64),
  ...over,
});
