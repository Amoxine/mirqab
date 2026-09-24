// Shared by every portal component test — not a test file itself (vitest only picks up `*.test.ts(x)`).
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import portalMessages from '@/messages/en/portal.json';
import commonMessages from '@/messages/en/common.json';

export const wrap = (ui: ReactNode) => (
  <NextIntlClientProvider locale="en" messages={{ portal: portalMessages, common: commonMessages }}>
    {ui}
  </NextIntlClientProvider>
);
