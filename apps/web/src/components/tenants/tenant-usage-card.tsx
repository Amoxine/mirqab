'use client';

import { useState } from 'react';
import { Gauge, RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { useResetTenantQuota, useTenantUsage } from '@/hooks/use-tenants';
import { TenantQuotaSheet } from './tenant-quota-sheet';

function quotaUsedPercent(max: number | null, used: number | null): number | null {
  if (max === null || used === null || max < 0) return null;
  return Math.min(100, Math.max(0, (used / max) * 100));
}

interface TenantUsageCardProps {
  tenantId: string;
  tenantName: string;
  /** Only an admin of this tenant (or super_admin) can edit/reset the ceiling — `tenant:update`. */
  canManage: boolean;
}

/** U14's "Usage tab": metered calls vs the plan allowance, plus org quota reset. Rendered as a card
 * alongside Overview/Members (this page has no Tabs shell to join today) rather than as its own tab. */
export function TenantUsageCard({ tenantId, tenantName, canManage }: TenantUsageCardProps) {
  const t = useTranslations('tenants');
  const tCommon = useTranslations('common');
  const { data: usage, isLoading, isError, error, refetch } = useTenantUsage(tenantId);
  const resetMutation = useResetTenantQuota(tenantId);
  const [quotaOpen, setQuotaOpen] = useState(false);

  const percent = usage ? quotaUsedPercent(usage.quotaMax, usage.used) : null;

  const handleReset = async () => {
    try {
      await resetMutation.mutateAsync();
      toast.success(t('quota.resetSuccess'));
    } catch (error_) {
      toast.error(error_ instanceof Error ? error_.message : t('quota.resetFailed'));
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-lg">{t('usage.title')}</CardTitle>
          <CardDescription>{t('usage.description')}</CardDescription>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setQuotaOpen(true);
              }}
            >
              <Gauge className="me-2 h-4 w-4" />
              {t('quota.editAction')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void handleReset()} disabled={resetMutation.isPending}>
              <RotateCw className={`me-2 h-4 w-4 ${resetMutation.isPending ? 'animate-spin' : ''}`} />
              {t('usage.resetButton')}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : isError || !usage ? (
          <div className="flex flex-col items-start gap-3 rounded-md border border-destructive/50 p-4">
            <p className="text-sm text-destructive">
              {error instanceof Error ? error.message : t('usage.loadFailed')}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
              {tCommon('retry')}
            </Button>
          </div>
        ) : percent !== null ? (
          <>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">{t('usage.quota')}</span>
              <span className="tabular-nums text-muted-foreground">
                {t('usage.quotaUsed', {
                  used: (usage.used ?? 0).toLocaleString(),
                  max: (usage.quotaMax ?? 0).toLocaleString(),
                })}
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={t('usage.quotaUsedAria')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
              className="h-2 w-full overflow-hidden rounded-full bg-secondary"
            >
              <div
                className={`h-full rounded-full transition-all ${percent >= 90 ? 'bg-destructive' : 'bg-primary'}`}
                style={{ width: `${String(percent)}%` }}
              />
            </div>
            {usage.isInactive && <p className="text-sm text-destructive">{t('quota.inactiveNotice')}</p>}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('usage.noQuota')}</p>
        )}
      </CardContent>
      <TenantQuotaSheet tenantId={tenantId} tenantName={tenantName} open={quotaOpen} onOpenChange={setQuotaOpen} />
    </Card>
  );
}
