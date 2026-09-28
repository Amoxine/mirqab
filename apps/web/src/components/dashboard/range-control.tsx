'use client';

import { useTranslations } from 'next-intl';
import { ANALYTICS_RANGES } from '@/hooks/use-analytics';
import { cn } from '@/lib/utils';
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
    <div
      role="group"
      aria-label={tAnalytics('rangeLabel')}
      className="bg-foreground/[0.06] inline-flex items-center gap-0.5 rounded-full p-1"
    >
      {ANALYTICS_RANGES.map((range) => {
        const active = range.value === value;
        return (
          <button
            key={range.value}
            type="button"
            aria-pressed={active}
            title={tAnalytics(`ranges.${range.value}`)}
            onClick={() => {
              onChange(range.value);
            }}
            className={cn(
              'pointer-coarse:min-h-11 h-9 whitespace-nowrap rounded-full px-3.5 text-sm font-medium transition-[color,background-color,box-shadow] duration-200',
              active
                ? 'bg-card text-foreground ring-foreground/5 shadow-sm ring-1'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`rangeShort.${range.value}`)}
          </button>
        );
      })}
    </div>
  );
}
