// Shared by the tenants component tests (members-card, invite-member-sheet) — not a test file itself.
import type { ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { vi } from 'vitest';
import enCommon from '@/messages/en/common.json';
import enDashboard from '@/messages/en/dashboard.json';
import enTenants from '@/messages/en/tenants.json';

const MESSAGES = { common: enCommon, dashboard: enDashboard, tenants: enTenants };

export function renderUi(ui: ReactNode): RenderResult & { client: QueryClient } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={MESSAGES}>
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

export interface Call {
  method: string;
  path: string;
  body: string | undefined;
}

interface Reply {
  status: number;
  body?: unknown;
}

/** Stubs `fetch` for the API client: `route(call)` answers each request (a Promise for one that answers later or never). */
export function mockFetch(route: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  const fn = vi.fn((input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/api/, '') + url.search,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return Promise.resolve(route(call)).then(
      (reply) =>
        new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

/** A request that never answers, for "still loading" states. */
export const never = (): Promise<never> =>
  new Promise<never>(() => {
    /* pending forever */
  });

export const ok = (data: unknown, meta?: Record<string, unknown>) => ({
  status: 200,
  body: meta ? { success: true, data, meta } : { success: true, data },
});
export const fail = (status: number, message: string, code = 'ERR') => ({
  status,
  body: { success: false, error: { code, message } },
});
