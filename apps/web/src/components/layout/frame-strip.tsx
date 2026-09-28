'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { isPipelineStale } from '@/components/analytics/pipeline-status';
import { useAnalyticsHealth } from '@/hooks/use-analytics';
import { useAuth } from '@/hooks/use-auth';
import { usePermissions } from '@/hooks/use-permissions';
import { getActiveTenantId } from '@/lib/active-tenant';
import { cn } from '@/lib/utils';

/** "UTC+01:00" for the viewer's current offset. */
function utcOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const abs = Math.abs(minutes);
  const sign = minutes >= 0 ? '+' : '−';
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** Local wall clock, rendered only after mount so server and client HTML agree. */
function Clock() {
  const locale = useLocale();
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => {
      setNow(new Date());
    }, 20_000);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  if (!now) return <span className="inline-block w-24" aria-hidden="true" />;
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return (
    <span dir="ltr" className="whitespace-nowrap">
      <time dateTime={now.toISOString()} className="text-frame-foreground">
        {time}
      </time>{' '}
      {utcOffset(now)}
    </span>
  );
}

/** Pipeline state as a dot + label — only for users who may read analytics. */
function PipelineIndicator() {
  const { data, isLoading, error } = useAnalyticsHealth();
  const t = useTranslations('dashboard.frame');
  if (isLoading) return null;

  const state =
    error || !data
      ? 'unknown'
      : data.pipelineReady
        ? 'live'
        : isPipelineStale(data)
          ? 'stale'
          : 'off';
  const dot = {
    live: 'bg-[#4ade80] shadow-[0_0_0_3px_rgb(74_222_128/0.2)]',
    stale: 'bg-[#fbbf24] shadow-[0_0_0_3px_rgb(251_191_36/0.2)]',
    off: 'bg-frame-muted',
    unknown: 'bg-frame-muted',
  }[state];

  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className={cn('size-1.5 rounded-full', dot)} aria-hidden="true" />
      {t(`pipeline.${state}`)}
    </span>
  );
}

/**
 * The strip on the dark frame above the dashboard panel (lg+ only): brand on the start side,
 * workspace context, analytics pipeline state and the viewer's local time on the end side.
 */
export function FrameStrip({ className }: { className?: string }) {
  const { user } = useAuth();
  const { can } = usePermissions();
  const t = useTranslations('dashboard.frame');
  const tNav = useTranslations('nav');
  const activeId = getActiveTenantId();
  const tenant = user?.tenants.find((m) => m.tenantId === activeId)?.name ?? user?.tenantName;

  return (
    <div className={cn('text-frame-muted h-11 items-center justify-between gap-4 px-3', className)}>
      <div className="flex min-w-0 items-baseline gap-3">
        <span className="text-frame-foreground text-[0.8rem] font-bold tracking-[0.22em]">
          {tNav('brand')}
        </span>
        <span className="hidden truncate font-mono text-[0.72rem] xl:inline">{t('caption')}</span>
      </div>
      <div className="flex items-center gap-5 font-mono text-[0.72rem]">
        {tenant && <span className="hidden max-w-48 truncate xl:inline">{tenant}</span>}
        {can('analytics:read') && <PipelineIndicator />}
        <Clock />
      </div>
    </div>
  );
}
