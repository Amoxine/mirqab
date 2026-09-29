'use client';

import { useLocale } from 'next-intl';
import { Figure as BaseFigure, type FigureProps } from '@open-gateway/ui';

/** The shared `Figure` in the UI locale. */
export function Figure(props: Omit<FigureProps, 'locale'>) {
  const locale = useLocale();
  return <BaseFigure locale={locale} {...props} />;
}
