'use client';

import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { useLocale, useTranslations } from 'next-intl';
import { AnalyticsErrorState } from '@/components/analytics/analytics-empty-state';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useRecentAudit } from '@/hooks/use-audit';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import type { Locale } from '@/i18n/locales';

const DESTRUCTIVE_ACTIONS = new Set(['DELETED', 'REVOKED', 'SYNC_FAILED', 'QUOTA_EXCEEDED']);

/** `SYNC_SUCCEEDED` -> `Sync succeeded`
 * ponytail: left untranslated — this titlecases whatever Prisma `AuditAction` value the backend
 * sends, which (per `use-audit.ts`) is wider than this app's closed `AuditAction` union, so there's
 * no fixed set of action codes to map to translation keys without breaking on the next backend value. */
function actionLabel(action: string): string {
  const words = action.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function RecentActivityCard() {
  const { data, isLoading, error, refetch } = useRecentAudit();
  const t = useTranslations('dashboard.recentActivity');
  const locale = dateFnsLocale(useLocale() as Locale);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <Link href="/audit-logs" className="text-sm text-primary hover:underline">
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
          <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="divide-y">
            {data.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <Badge variant={DESTRUCTIVE_ACTIONS.has(entry.action) ? 'destructive' : 'secondary'} className="shrink-0">
                    {actionLabel(entry.action)}
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
                  title={new Date(entry.createdAt).toLocaleString()}
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
