'use client';

import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { useLocale, useTranslations } from 'next-intl';
import { History } from 'lucide-react';
import { AnalyticsErrorState } from '@/components/analytics/analytics-empty-state';
import { StateMessage } from '@/components/shared/state-card';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useRecentAudit } from '@/hooks/use-audit';
import { auditActionLabel } from '@/lib/audit-actions';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import type { Locale } from '@/i18n/locales';
import { useFormat } from '@/hooks/use-format';

const DESTRUCTIVE_ACTIONS = new Set(['DELETED', 'REVOKED', 'SYNC_FAILED', 'QUOTA_EXCEEDED']);


export function RecentActivityCard() {
  const { data, isLoading, error, refetch } = useRecentAudit();
  const t = useTranslations('dashboard.recentActivity');
  // Known actions are translated (the same labels as the Audit Logs page); an unknown one shows its raw code.
  const tAnalytics = useTranslations('analytics');
  const locale = dateFnsLocale(useLocale() as Locale);
  const fmt = useFormat();

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <Link href="/audit-logs" className="rounded-sm text-sm font-medium text-primary hover:underline">
          {t('viewAll')}
        </Link>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : error ? (
          <AnalyticsErrorState message={error.message} onRetry={() => void refetch()} />
        ) : !data?.length ? (
          <StateMessage icon={<History aria-hidden="true" />} message={t('empty')} className="py-6" />
        ) : (
          <ul className="divide-y">
            {data.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <Badge variant={DESTRUCTIVE_ACTIONS.has(entry.action) ? 'destructive' : 'secondary'} className="shrink-0">
                    {auditActionLabel(tAnalytics, entry.action)}
                  </Badge>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium capitalize">{entry.resource}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {entry.user ? (entry.user.name ?? entry.user.email) : t('system')}
                    </p>
                  </div>
                </div>
                <time
                  dateTime={entry.createdAt}
                  className="shrink-0 text-xs text-muted-foreground"
                  title={fmt.dateTime(entry.createdAt)}
                >
                  {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true, locale })}
                </time>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
