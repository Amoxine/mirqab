'use client';

import { useMemo } from 'react';
import { cn } from '../lib/utils';

const SMALL_PARTS = new Set<Intl.NumberFormatPartTypes>(['unit', 'compact', 'percentSign']);

type Kind = 'compact' | 'percent' | 'ms';

/** Formatters in the UI locale; `percent` takes a 0-100 value, as the analytics API returns it. */
function useFormatters(locale: string) {
  return useMemo(
    () => ({
      compact: new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }),
      percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }),
      ms: new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: 'millisecond',
        maximumFractionDigits: 0,
      }),
    }),
    [locale],
  );
}

/**
 * A display number with its unit, compact suffix or % sign set small beside it ("47 ms", "21 M",
 * "99.57 %"), so the figure keeps its size in every locale — Arabic units such as "ملي ث" are long.
 */
export interface FigureProps {
  value: number;
  kind: Kind;
  /** BCP 47 tag the digits and units are formatted in (the UI locale). */
  locale: string;
  className?: string;
}

export function Figure({ value, kind, locale, className }: FigureProps) {
  const formatters = useFormatters(locale);
  const parts = formatters[kind].formatToParts(kind === 'percent' ? value / 100 : value);
  return (
    <span className={cn('whitespace-nowrap', className)}>
      {parts.map((part, i) =>
        SMALL_PARTS.has(part.type) ? (
          <span key={i} className="text-muted-foreground text-[0.5em] font-normal tracking-normal">
            {part.value}
          </span>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </span>
  );
}
