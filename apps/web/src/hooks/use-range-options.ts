import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { ANALYTICS_RANGES } from '@/hooks/use-analytics';
import type { AnalyticsRange } from '@/types';

/**
 * The analytics time ranges as chip options (short label + long tooltip), in one place so the
 * `RangeControl` and any filter bar with a range field cannot label them differently.
 */
export function useRangeOptions(): { value: AnalyticsRange; label: string; title: string }[] {
  const t = useTranslations('dashboard.page');
  const tAnalytics = useTranslations('analytics');
  return useMemo(
    () =>
      ANALYTICS_RANGES.map((range) => ({
        value: range.value,
        label: t(`rangeShort.${range.value}`),
        title: tAnalytics(`ranges.${range.value}`),
      })),
    [t, tAnalytics],
  );
}
