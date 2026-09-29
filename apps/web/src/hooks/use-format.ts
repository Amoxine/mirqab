'use client';

import { useMemo } from 'react';
import { useLocale } from 'next-intl';

type DateInput = string | number | Date;

/**
 * The one place dates, counts, rates and durations are formatted (guidelines §8), always in the UI
 * locale rather than the browser's. Units come from Intl too (`ms` → `م.ث` in Arabic), so no
 * unit string is hand-written per page. Formatters are built once per locale.
 */
export function createFormat(locale: string) {
  const date = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const number = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const ms = new Intl.NumberFormat(locale, { style: 'unit', unit: 'millisecond', maximumFractionDigits: 0 });
  const byteUnits = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
  const byteFormats = byteUnits.map(
    (unit) => new Intl.NumberFormat(locale, { style: 'unit', unit, maximumFractionDigits: unit === 'byte' ? 0 : 1 }),
  );
  const toDate = (value: DateInput) => (value instanceof Date ? value : new Date(value));
  return {
    date: (value: DateInput) => date.format(toDate(value)),
    dateTime: (value: DateInput) => dateTime.format(toDate(value)),
    number: (value: number) => number.format(value),
    /** `value` is already a percentage (0-100), as the analytics API returns it. */
    percent: (value: number) => percent.format(value / 100),
    ms: (value: number) => ms.format(value),
    /** Decimal (1000-based) sizes, in the largest unit that keeps the figure >= 1. */
    bytes: (value: number) => {
      const step = Math.min(byteUnits.length - 1, Math.max(0, Math.floor(Math.log10(Math.max(value, 1)) / 3)));
      const format = byteFormats[step];
      return format ? format.format(value / 1000 ** step) : String(value);
    },
  };
}

export type Format = ReturnType<typeof createFormat>;

export function useFormat(): Format {
  const locale = useLocale();
  return useMemo(() => createFormat(locale), [locale]);
}
