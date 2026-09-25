'use client';

import { useFormat } from '@/hooks/use-format';

type DateInput = string | number | Date;

/* Column cells are plain render functions (no hooks), so they format through these instead of
   threading a formatter through every column factory. Same `useFormat` underneath. */

export function FormattedDate({ value }: { value: DateInput }) {
  const fmt = useFormat();
  return <time dateTime={new Date(value).toISOString()}>{fmt.date(value)}</time>;
}

export function FormattedDateTime({ value }: { value: DateInput }) {
  const fmt = useFormat();
  return <time dateTime={new Date(value).toISOString()}>{fmt.dateTime(value)}</time>;
}

export function FormattedNumber({ value }: { value: number }) {
  return <>{useFormat().number(value)}</>;
}
