'use client';

import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { useLocale, useTranslations } from 'next-intl';
import { History } from 'lucide-react';
import { AnalyticsErrorState } from '@/components/analytics/analytics-empty-state';
import { StateMessage } from '@/components/shared/state-card';
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
        <Link
          href="/audit-logs"
          className="text-primary rounded-sm text-sm font-medium hover:underline"
        >
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
          <StateMessage
            icon={<History aria-hidden="true" />}
            message={t('empty')}
            className="py-6"
          />
        ) : (
          <div
            role="log"
            aria-label={t('logLabel')}
            className="bg-ink text-secondary-foreground overflow-hidden rounded-[0.875rem] pb-3 font-mono text-xs"
          >
            <div className="text-secondary-foreground/55 flex justify-between gap-3 border-b border-white/10 px-3.5 py-2 text-[0.68rem]">
              <span>{t('logName')}</span>
              <span>{t('events', { count: data.length })}</span>
            </div>
            <ul>
              {data.map((entry) => (
                <li key={entry.id} className="flex gap-2.5 px-3.5 pt-2.5 leading-relaxed">
                  <time
                    dateTime={entry.createdAt}
                    dir="ltr"
                    className="text-secondary-foreground/45 shrink-0"
                    title={fmt.dateTime(entry.createdAt)}
                  >
                    {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true, locale })}
                  </time>
                  <span aria-hidden="true" className="shrink-0 text-[#22b8c9]">
                    {'›'}
                  </span>
                  <span className="min-w-0 break-words">
                    <b
                      className={
                        DESTRUCTIVE_ACTIONS.has(entry.action)
                          ? 'font-medium text-[#f87171]'
                          : 'font-medium text-[#22b8c9]'
                      }
                    >
                      {auditActionLabel(tAnalytics, entry.action)}
                    </b>{' '}
                    <span dir="auto" className="capitalize">
                      {entry.resource}
                    </span>{' '}
                    <span className="text-secondary-foreground/60">
                      {entry.user ? (entry.user.name ?? entry.user.email) : t('system')}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
