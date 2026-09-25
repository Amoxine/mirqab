'use client';

import { useTranslations } from 'next-intl';
import { RouteError } from '@/components/shared/route-error';

export default function PortalError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('portal.docs');
  return <RouteError reset={reset} homeHref="/portal" homeLabel={t('backToCatalog')} />;
}
