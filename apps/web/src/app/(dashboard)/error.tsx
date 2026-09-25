'use client';

import { useTranslations } from 'next-intl';
import { RouteError } from '@/components/shared/route-error';

export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('dashboard.errorBoundary');
  return <RouteError reset={reset} homeHref="/" homeLabel={t('home')} />;
}
