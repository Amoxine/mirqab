// @vitest-environment jsdom
import { cloneElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import type * as Recharts from 'recharts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import enAnalytics from '@/messages/en/analytics.json';
import arAnalytics from '@/messages/ar/analytics.json';
import frAnalytics from '@/messages/fr/analytics.json';
import { mockFetch, ok } from '@/components/apis/endpoints/test-utils';
import { LatencyChart } from './latency-chart';

/** What the chart hands to the tooltip: the value it formats and the unit it would append. */
let tooltip: { formatter?: (value: unknown) => ReactNode } = {};
let line: Record<string, unknown> = {};
// jsdom has no layout, so a ResponsiveContainer measures 0 x 0 and draws nothing; give the chart a size.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof Recharts>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width?: number; height?: number }> }) =>
      cloneElement(children, { width: 600, height: 280 }),
    Tooltip: (props: ComponentProps<typeof actual.Tooltip>) => {
      tooltip = props as typeof tooltip;
      return <actual.Tooltip {...props} />;
    },
    Line: (props: ComponentProps<typeof actual.Line>) => {
      line = props as Record<string, unknown>;
      return <actual.Line {...props} />;
    },
  };
});

const MESSAGES = { en: enAnalytics, fr: frAnalytics, ar: arAnalytics };
const WAIT = { timeout: 8000 };
const points = [0, 100, 200, 300, 400].map((ms, i) => ({
  bucket: `2026-09-29T0${String(i)}:00:00.000Z`,
  requests: 10,
  errors: 0,
  avgLatencyMs: ms,
}));
/** The unit as Intl writes it for the locale: the one place a locale's "ms" comes from. */
const ms = (locale: string, value: number) =>
  new Intl.NumberFormat(locale, { style: 'unit', unit: 'millisecond', maximumFractionDigits: 0 }).format(value);

function mount(locale: 'en' | 'fr' | 'ar') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={{ analytics: MESSAGES[locale] }}>
        <LatencyChart range="24h" />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}
const yTicks = () =>
  Array.from(document.querySelectorAll('text[orientation="left"]')).map((el) => el.textContent);

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  tooltip = {};
  line = {};
  mockFetch(() => ok(points));
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  errors.mockRestore();
  cleanup();
});

describe.each(['en', 'fr', 'ar'] as const)('LatencyChart units in %s', (locale) => {
  it('writes the axis ticks in the locale’s own unit, as Intl writes it', async () => {
    mount(locale);
    await waitFor(() => {
      expect(yTicks().length).toBeGreaterThanOrEqual(3);
    }, WAIT);
    const allowed = new Set([0, 100, 200, 300, 400].map((value) => ms(locale, value)));
    expect(yTicks().filter((tick) => !allowed.has(tick))).toEqual([]);
  });

  it('writes the tooltip value in that unit too, and appends no unit of its own', async () => {
    mount(locale);
    await waitFor(() => {
      expect(tooltip.formatter).toBeTypeOf('function');
    }, WAIT);
    expect(tooltip.formatter?.(340)).toBe(ms(locale, 340));
    expect('unit' in line ? line.unit : undefined).toBeUndefined();
  });

  it('raises no translation error', async () => {
    mount(locale);
    await waitFor(() => {
      expect(yTicks().length).toBeGreaterThan(0);
    }, WAIT);
    expect(errors.mock.calls.filter((call) => String(call[0]).includes('IntlError'))).toEqual([]);
  });
});

describe('LatencyChart in Arabic', () => {
  it('does not show the English unit anywhere in the axis', async () => {
    mount('ar');
    await waitFor(() => {
      expect(yTicks().length).toBeGreaterThanOrEqual(3);
    }, WAIT);
    expect(yTicks().filter((tick) => /\bms\b/.test(tick))).toEqual([]);
  });
});
