'use client';

import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { PermissionGate } from '@/components/auth/permission-gate';
import { toast } from '@/components/ui/sonner';
import { useSyncApi } from '@/hooks/use-apis';
import type { ApiSyncStatus } from '@/types';

const VARIANT: Record<ApiSyncStatus, 'default' | 'secondary' | 'destructive'> = {
  SYNCED: 'default',
  PENDING: 'secondary',
  FAILED: 'destructive',
};

interface SyncStatusBadgeProps {
  apiId: string;
  syncStatus: ApiSyncStatus;
  syncError: string | null;
}

/** Gateway sync state of an API. `FAILED` reveals the error in a tooltip and offers Retry. */
export function SyncStatusBadge({ apiId, syncStatus, syncError }: SyncStatusBadgeProps) {
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  const syncMutation = useSyncApi();
  const label: Record<ApiSyncStatus, string> = {
    SYNCED: t('sync.synced'),
    PENDING: t('sync.pending'),
    FAILED: t('sync.failed'),
  };

  const handleRetry = async () => {
    try {
      // A failed gateway sync still answers 200: read the outcome from the body, not the HTTP status.
      const result = await syncMutation.mutateAsync(apiId);
      if (result.syncStatus === 'SYNCED') {
        toast.success(t('sync.syncedToast'));
      } else {
        toast.error(t('sync.syncFailedToast', { error: result.syncError ?? t('unknownGatewayError') }));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('sync.syncErrorToast'));
    }
  };

  const badge = <Badge variant={VARIANT[syncStatus]}>{label[syncStatus]}</Badge>;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {syncStatus === 'FAILED' && syncError ? (
        <TooltipProvider delayDuration={100}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="cursor-help rounded-full">
                {badge}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs break-words">{syncError}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        badge
      )}
      {syncStatus === 'FAILED' && (
        <PermissionGate permission="api:sync">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2"
            disabled={syncMutation.isPending}
            onClick={() => {
              void handleRetry();
            }}
          >
            <RefreshCw className={`me-1 h-3 w-3 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
            {syncMutation.isPending ? t('sync.retrying') : tCommon('retry')}
          </Button>
        </PermissionGate>
      )}
    </div>
  );
}
