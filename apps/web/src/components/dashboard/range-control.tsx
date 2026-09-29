'use client';

import { useTranslations } from 'next-intl';
import { SegmentedControl } from '@open-gateway/ui';
import { ANALYTICS_RANGES } from '@/hooks/use-analytics';
import type { AnalyticsRange } from '@/types';

/**
 * The one analytics time-range picker (1h / 24h / 7d / 30d): every page or card that scopes
 * analytics to a range uses this, so the labels, tooltips and behaviour cannot drift apart.
 */
export function RangeControl({
  value,
  onChange,
}: {
  value: AnalyticsRange;
  onChange: (range: AnalyticsRange) => void;
}) {
  const t = useTranslations('dashboard.page');
  const tAnalytics = useTranslations('analytics');

  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      ariaLabel={tAnalytics('rangeLabel')}
      options={ANALYTICS_RANGES.map((range) => ({
        value: range.value,
        label: t(`rangeShort.${range.value}`),
        title: tAnalytics(`ranges.${range.value}`),
      }))}
    />
  );
}
