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
  const toDate = (value: DateInput) => (value instanceof Date ? value : new Date(value));
  return {
    date: (value: DateInput) => date.format(toDate(value)),
    dateTime: (value: DateInput) => dateTime.format(toDate(value)),
    number: (value: number) => number.format(value),
    /** `value` is already a percentage (0-100), as the analytics API returns it. */
    percent: (value: number) => percent.format(value / 100),
    ms: (value: number) => ms.format(value),
  };
}

export type Format = ReturnType<typeof createFormat>;

export function useFormat(): Format {
  const locale = useLocale();
  return useMemo(() => createFormat(locale), [locale]);
}
