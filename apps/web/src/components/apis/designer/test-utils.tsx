// Shared by every Sheet's component test in this directory — not a test file itself (vitest only
// picks up `*.test.ts(x)`).
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import apisMessages from '@/messages/en/apis.json';
import commonMessages from '@/messages/en/common.json';
import type { ApiDefinition } from '@/hooks/use-apis';

/** `arr[i]`, but throws instead of typing as `T | undefined` — used to index a multi-match RTL
 * query (e.g. `getAllByLabelText`) without a forbidden non-null assertion. */
export function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) throw new Error(`index ${String(index)} is out of range`);
  return value;
}

export const wrap = (ui: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={{ apis: apisMessages, common: commonMessages }}>
    {ui}
  </NextIntlClientProvider>
);

/** A fully-populated API row, minus `config` (each test overrides the section it exercises). */
export const baseApi: ApiDefinition = {
  id: 'api-1',
  name: 'Orders',
  slug: 'orders',
  status: 'ACTIVE',
  authType: 'AUTH_TOKEN',
  proxyUrl: 'http://orders:4000',
  listenPath: '/orders/',
  tykApiId: 'og-orders',
  syncStatus: 'SYNCED',
  syncError: null,
  lastSyncedAt: null,
  config: {},
  oasDocument: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
