'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { usePortalUsage } from '@/hooks/use-portal';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

/** The WP22 usage/quota view (WP23), rendered inline per subscription — this developer's own
 * consumption against their plan's allowance. Only meaningful once a key exists (APPROVED). */
export function SubscriptionUsage({ applicationId, subscriptionId }: { applicationId: string; subscriptionId: string }) {
  const t = useTranslations('portal');
  const { data: usage, isLoading, isError } = usePortalUsage(applicationId, subscriptionId, '24h');

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (isError || !usage) {
    return <p className="text-sm text-muted-foreground">{t('usage.loadError')}</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label={t('usage.requests')} value={String(usage.requests)} />
      <Stat label={t('usage.errorRate')} value={`${String(usage.errorRate)}%`} />
      <Stat label={t('usage.avgLatency')} value={t('usage.msValue', { ms: usage.avgLatencyMs })} />
      <Stat
        label={t('usage.quota')}
        value={
          usage.quotaMax === null
            ? t('usage.noQuota')
            : t('usage.quotaValue', { remaining: usage.quotaRemaining ?? 0, max: usage.quotaMax })
        }
      />
    </div>
  );
}
