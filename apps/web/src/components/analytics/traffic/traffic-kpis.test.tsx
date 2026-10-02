// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import ar from '@/messages/ar/analytics.json';
import arCommon from '@/messages/ar/common.json';
import arDashboard from '@/messages/ar/dashboard.json';
import en from '@/messages/en/analytics.json';
import enCommon from '@/messages/en/common.json';
import enDashboard from '@/messages/en/dashboard.json';
import fr from '@/messages/fr/analytics.json';
import frCommon from '@/messages/fr/common.json';
import frDashboard from '@/messages/fr/dashboard.json';
import type { AnalyticsTraffic } from '@/types';
import { TrafficKpis } from './traffic-kpis';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const MESSAGES = {
  en: { analytics: en, common: enCommon, dashboard: enDashboard },
  fr: { analytics: fr, common: frCommon, dashboard: frDashboard },
  ar: { analytics: ar, common: arCommon, dashboard: arDashboard },
};

const traffic = (lastRequestAt: string | null): AnalyticsTraffic => ({
  range: '24h',
  windowSeconds: 86_400,
  summary: {
    requests: 1_000, requestsPerSecond: 0.01, errors: 0, errorRate: 0, clientErrors: 0, serverErrors: 0,
    avgLatencyMs: 80, avgUpstreamLatencyMs: 60, p50LatencyMs: 50, p95LatencyMs: 200, p99LatencyMs: 300,
    uniqueClients: 5, uniqueKeys: 3, anonymousShare: 0, bytesIn: 1_000, lastRequestAt,
  },
  timeseries: [], statusClasses: [], statusCodes: [], methods: [], topEndpoints: [], slowestEndpoints: [],
});
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The text of the tiles, which holds the caption under the requests figure. */
function caption(locale: 'en' | 'fr' | 'ar', lastRequestAt: string | null) {
  const { container } = render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <TrafficKpis data={traffic(lastRequestAt)} />
    </NextIntlClientProvider>,
  );
  return container.textContent;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the traffic requests tile caption', () => {
  it.each([
    ['10 seconds', 10 * SECOND, 'Last request less than a minute ago'],
    ['1 minute', MINUTE, 'Last request 1 minute ago'],
    ['5 minutes', 5 * MINUTE, 'Last request 5 minutes ago'],
    ['3 hours', 3 * HOUR, 'Last request about 3 hours ago'],
    ['2 days', 2 * DAY, 'Last request 2 days ago'],
  ])('reads as a sentence in English, %s after the last request', (_name, age, expected) => {
    expect(caption('en', ago(age))).toContain(expected);
  });

  it('never reads "Last 1 minute ago": the word before the time says what is dated', () => {
    for (const age of [MINUTE, HOUR, DAY]) {
      cleanup();
      expect(caption('en', ago(age))).not.toMatch(/Last (?!request)/);
    }
  });

  it.each([
    ['1 minute', MINUTE],
    ['5 minutes', 5 * MINUTE],
    ['3 hours', 3 * HOUR],
    ['2 days', 2 * DAY],
  ])('reads as a sentence in French, %s after the last request', (_name, age) => {
    expect(caption('fr', ago(age))).toMatch(/Dernière requête il y a /);
  });

  it.each([
    ['1 minute', MINUTE],
    ['5 minutes', 5 * MINUTE],
    ['3 hours', 3 * HOUR],
    ['2 days', 2 * DAY],
  ])('reads as a sentence in Arabic, %s after the last request', (_name, age) => {
    expect(caption('ar', ago(age))).toMatch(/آخر طلب منذ /);
  });

  it.each(['en', 'fr', 'ar'] as const)('does not say "in a few minutes" for a request dated a little ahead of the clock, in %s', (locale) => {
    const text = caption(locale, ago(-5 * MINUTE));
    expect(text).not.toMatch(/\bin \d|dans \d|خلال/);
    expect(text).toMatch(locale === 'en' ? /Last request less than a minute ago/ : locale === 'fr' ? /Dernière requête il y a moins d’une minute|Dernière requête il y a moins d'une minute/ : /آخر طلب منذ /);
  });

  it('says the other thing when there is nothing to date', () => {
    expect(caption('en', null)).toContain(en.traffic.kpis.noRequests);
  });
});
