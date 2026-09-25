'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, FileCheck2, FileDiff } from 'lucide-react';
import { StateMessage } from '@/components/shared/state-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/hooks/use-format';
import { useSpecUpdates } from '@/lib/api/spec-source';

/** OAS-08 "Specs with updates": APIs whose watched URL serves a version nobody has reviewed yet. */
export function SpecUpdatesCard() {
  const t = useTranslations('specSource.dashboard');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  const { data, isPending, isError, refetch } = useSpecUpdates();

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <FileDiff className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : isError ? (
          <StateMessage
            role="alert"
            icon={<AlertTriangle className="text-destructive" aria-hidden="true" />}
            message={t('loadError')}
            className="py-6"
          >
            <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => void refetch()}>
              {tCommon('retry')}
            </Button>
          </StateMessage>
        ) : data.length === 0 ? (
          <StateMessage icon={<FileCheck2 aria-hidden="true" />} message={t('empty')} className="py-6" />
        ) : (
          <ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
            {data.map((u) => {
              const governed = u.diff.governedRemoved + u.diff.governedChanged;
              return (
                <li key={u.candidateId} className="p-3">
                  <Link
                    href={`/apis/${u.apiId}?tab=endpoints`}
                    className="flex min-h-11 flex-col justify-center rounded-sm text-sm font-medium hover:underline"
                  >
                    {u.apiName}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {t('counts', { added: u.diff.added, removed: u.diff.removed, changed: u.diff.changed })}
                    {' · '}
                    <time dateTime={u.detectedAt}>{fmt.dateTime(u.detectedAt)}</time>
                  </p>
                  {governed > 0 && <p className="text-xs font-medium">{t('governed', { count: governed })}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
