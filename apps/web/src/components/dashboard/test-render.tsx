// Shared by the click-through component tests (dashboard, analytics, audit): not a test file itself.
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { act, render, type RenderResult } from '@testing-library/react';
import { ROW_CLICK_DELAY_MS } from '@open-gateway/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import analytics from '@/messages/en/analytics.json';
import apis from '@/messages/en/apis.json';
import auth from '@/messages/en/auth.json';
import common from '@/messages/en/common.json';
import dashboard from '@/messages/en/dashboard.json';
import keys from '@/messages/en/keys.json';

export const EN = { analytics, apis, auth, common, dashboard, keys };

/**
 * Runs `body` on a clock the test moves. A plain click on a linked row waits out a possible double
 * click before it acts, so a test steps that window with `pass()` instead of waiting real time for it
 * (and a negative assertion is about what happened, not about how long it was given). Call it after
 * the page has loaded: a page's own queries need the real clock.
 */
export function withRowClock(body: (pass: () => void) => void): void {
  vi.useFakeTimers();
  try {
    body(() => {
      act(() => {
        vi.advanceTimersByTime(ROW_CLICK_DELAY_MS + 10);
      });
    });
  } finally {
    vi.useRealTimers();
  }
}

/**
 * English messages and a fresh query client, the way the app mounts a page. The providers are the
 * render's `wrapper`, so `rerender(ui)` keeps them (a test that changes the mocked URL re-renders).
 */
export function renderApp(ui: ReactNode): RenderResult {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={EN}>
          {children}
        </NextIntlClientProvider>
      </QueryClientProvider>
    ),
  });
}
