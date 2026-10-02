'use client';

import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { useLocale, useTranslations } from 'next-intl';
import { History } from 'lucide-react';
import { AnalyticsErrorState } from '@/components/analytics/analytics-empty-state';
import { StretchedLink } from '@/components/shared/row-link';
import { StateMessage } from '@/components/shared/state-card';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useRecentAudit } from '@/hooks/use-audit';
import { auditActionLabel } from '@/lib/audit-actions';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import type { Locale } from '@/i18n/locales';
import { ScopeTag } from './scope-tag';
import { useFormat } from '@/hooks/use-format';

const DESTRUCTIVE_ACTIONS = new Set(['DELETED', 'REVOKED', 'SYNC_FAILED', 'QUOTA_EXCEEDED']);

/** The latest audit entries; narrowed to one API's own entries when the dashboard is scoped to it (`scope`). */
export function RecentActivityCard({ scope }: { scope?: { id: string; name: string } | null }) {
  const { data, isLoading, error, refetch } = useRecentAudit(scope?.id);
  const t = useTranslations('dashboard.recentActivity');
  // Known actions are translated (the same labels as the Audit Logs page); an unknown one shows its raw code.
  const tAnalytics = useTranslations('analytics');
  const locale = dateFnsLocale(useLocale() as Locale);
  const fmt = useFormat();

  return (
    <Card variant="ink">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        {/* A real heading, outside the log below: the card is a section of the page, the log its content. */}
        <h2 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-normal leading-tight tracking-tight">
          {t('title')}
          <ScopeTag name={scope?.name} />
        </h2>
        {/* Foreground, not the brand colour: the brand's lighter shades fall below 4.5:1 on the dark theme's ink. */}
        <Link
          href="/audit-logs"
          className="text-secondary-foreground rounded-sm text-sm font-medium underline underline-offset-4 hover:no-underline"
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
            message={scope ? t('emptyScoped') : t('empty')}
            className="py-6"
          />
        ) : (
          <div
            role="log"
            aria-label={t('logLabel')}
            className="border-border text-secondary-foreground overflow-hidden rounded-[0.875rem] border pb-3 font-mono text-xs"
          >
            <div className="text-secondary-foreground/70 flex justify-between gap-3 border-b border-white/10 px-3.5 py-2 text-[0.68rem]">
              <span>{t('logName')}</span>
              <span>{t('events', { count: data.length })}</span>
            </div>
            <ul>
              {data.map((entry) => (
                <li key={entry.id} className="relative flex gap-2.5 px-3.5 pt-2.5 leading-relaxed">
                  <time
                    dateTime={entry.createdAt}
                    dir="ltr"
                    className="text-secondary-foreground/70 shrink-0"
                    title={fmt.dateTime(entry.createdAt)}
                  >
                    {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true, locale })}
                  </time>
                  <span aria-hidden="true" className="text-primary shrink-0">
                    {'›'}
                  </span>
                  {/* The entry's text is one link to its detail in the audit log; its pseudo-element covers the whole row. */}
                  <StretchedLink href={`/audit-logs?open=${entry.id}`} className="after:rounded-none">
                    <span className="min-w-0 break-words">
                      <b
                        // Lighter red and plain foreground: each reaches 4.5:1 on both themes' ink (a test checks).
                        className={
                          DESTRUCTIVE_ACTIONS.has(entry.action)
                            ? 'font-medium text-[#fca5a5]'
                            : 'text-secondary-foreground font-semibold'
                        }
                      >
                        {auditActionLabel(tAnalytics, entry.action)}
                      </b>{' '}
                      <span dir="auto" className="capitalize">
                        {entry.resource}
                      </span>{' '}
                      <span className="text-secondary-foreground/75">
                        {entry.user ? (entry.user.name ?? entry.user.email) : t('system')}
                      </span>
                    </span>
                  </StretchedLink>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
