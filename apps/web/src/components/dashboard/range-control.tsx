'use client';

import { useTranslations } from 'next-intl';
import { SegmentedControl } from '@open-gateway/ui';
import { useRangeOptions } from '@/hooks/use-range-options';
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
  const tAnalytics = useTranslations('analytics');
  const options = useRangeOptions();

  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      ariaLabel={tAnalytics('rangeLabel')}
      options={options}
    />
  );
}
