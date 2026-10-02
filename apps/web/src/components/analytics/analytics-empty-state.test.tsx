// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import analyticsMessages from '@/messages/en/analytics.json';
import commonMessages from '@/messages/en/common.json';
import type { AnalyticsHealth } from '@/types';
import { AnalyticsEmptyState } from './analytics-empty-state';

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
