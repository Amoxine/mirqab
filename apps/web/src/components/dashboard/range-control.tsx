'use client';

import { useTranslations } from 'next-intl';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ANALYTICS_RANGES } from '@/hooks/use-analytics';
import type { AnalyticsRange } from '@/types';

/** The dashboard's one time-range filter: every analytics figure on the page follows it. */
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
    <ToggleGroup
      type="single"
      value={value}
      // A single-select group reports '' when the active item is clicked again; a range is always selected.
      onValueChange={(next) => {
        if (next) onChange(next as AnalyticsRange);
      }}
      aria-label={tAnalytics('rangeLabel')}
    >
      {ANALYTICS_RANGES.map((range) => (
        <ToggleGroupItem
          key={range.value}
          value={range.value}
          title={tAnalytics(`ranges.${range.value}`)}
          className="px-3.5"
        >
          {t(`rangeShort.${range.value}`)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
