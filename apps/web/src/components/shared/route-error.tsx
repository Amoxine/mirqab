'use client';

import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { StateCard } from '@/components/shared/state-card';
import { Button } from '@/components/ui/button';

interface RouteErrorProps {
  /** Next.js `error.tsx` reset: re-renders the segment. */
  reset: () => void;
  homeHref: string;
  homeLabel: string;
}

/**
 * Body of a route `error.tsx`: a render crash keeps the surrounding shell (sidebar, header) and
 * offers a retry, instead of Next's bare full-screen error.
 */
export function RouteError({ reset, homeHref, homeLabel }: RouteErrorProps) {
  const t = useTranslations('common');
  return (
    <StateCard
      role="alert"
      icon={<AlertTriangle className="text-destructive" aria-hidden="true" />}
      title={t('errorBoundary.title')}
      message={t('errorBoundary.message')}
    >
      <Button type="button" onClick={reset}>
        {t('retry')}
      </Button>
      <Button asChild variant="outline">
        <Link href={homeHref}>{homeLabel}</Link>
      </Button>
    </StateCard>
  );
}
