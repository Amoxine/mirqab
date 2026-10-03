// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import analyticsMessages from '@/messages/en/analytics.json';
import commonMessages from '@/messages/en/common.json';
import arAnalytics from '@/messages/ar/analytics.json';
import arCommon from '@/messages/ar/common.json';
import frAnalytics from '@/messages/fr/analytics.json';
import frCommon from '@/messages/fr/common.json';
import type { AnalyticsHealth } from '@/types';
import { AnalyticsEmptyState, AnalyticsStaleNotice } from './analytics-empty-state';

afterEach(cleanup);

const E = analyticsMessages.emptyState;
const healthy: AnalyticsHealth = {
  pipelineReady: true,
  pumpReachable: true,
  rawTablePresent: true,
  aggregateTablePresent: true,
  lastRecordAt: null,
  rowCount: 0,
};

const renderState = (health: AnalyticsHealth) =>
  render(
    <NextIntlClientProvider locale="en" messages={{ analytics: analyticsMessages, common: commonMessages }}>
      <AnalyticsEmptyState health={health} />
    </NextIntlClientProvider>,
  );

describe('AnalyticsEmptyState hint', () => {
  it('blames the collection service first, whatever the tables look like', () => {
    renderState({ ...healthy, pipelineReady: false, pumpReachable: false, rawTablePresent: false, aggregateTablePresent: false });
    expect(screen.getByText(E.hintPumpDown)).toBeDefined();
    expect(screen.queryByText(E.hintTablesMissing)).toBeNull();
  });

  it.each([{ rawTablePresent: false }, { aggregateTablePresent: false }])(
    'reports missing storage when the service is up but %o',
    (missing) => {
      renderState({ ...healthy, pipelineReady: false, ...missing });
      expect(screen.getByText(E.hintTablesMissing)).toBeDefined();
    },
  );

  it('asks for traffic when everything is in place but nothing was recorded', () => {
    renderState({ ...healthy, pipelineReady: false });
    expect(screen.getByText(E.hintNoTraffic)).toBeDefined();
  });

  it('shows no hint at all while the pipeline is ready', () => {
    renderState(healthy);
    expect(screen.getByText(E.noDataTitle)).toBeDefined();
    expect(screen.queryByText(E.hintNoTraffic)).toBeNull();
  });
});

describe('troubleshooting link', () => {
  const MESSAGES = {
    en: { analytics: analyticsMessages, common: commonMessages },
    fr: { analytics: frAnalytics, common: frCommon },
    ar: { analytics: arAnalytics, common: arCommon },
  };
  const renderIn = (locale: keyof typeof MESSAGES, ui: React.ReactElement) =>
    render(
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
        {ui}
      </NextIntlClientProvider>,
    );
  const notReady = { ...healthy, pipelineReady: false, pumpReachable: false };

  it.each(['en', 'fr', 'ar'] as const)('sends a pipeline that is not ready to the analytics troubleshooting section in %s', (locale) => {
    renderIn(locale, <AnalyticsEmptyState health={notReady} />);
    const name = MESSAGES[locale].analytics.emptyState.troubleshooting;
    expect(name).toBeTruthy();
    expect(screen.getByRole('link', { name }).getAttribute('href')).toBe('/docs/troubleshooting#analytics');
  });

  it.each(['en', 'fr', 'ar'] as const)('sends the stale-data notice there too in %s', (locale) => {
    renderIn(locale, <AnalyticsStaleNotice health={{ ...notReady, rowCount: 5, lastRecordAt: '2026-10-01T08:00:00Z' }} />);
    const name = MESSAGES[locale].analytics.emptyState.troubleshooting;
    expect(screen.getByRole('link', { name }).getAttribute('href')).toBe('/docs/troubleshooting#analytics');
  });

  it('adds no link to an ordinary empty chart, which would repeat on every card', () => {
    renderIn('en', <AnalyticsEmptyState health={healthy} />);
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();
    renderIn('en', <AnalyticsEmptyState />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
