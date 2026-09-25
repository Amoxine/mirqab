import type { useTranslations } from 'next-intl';
import { toast } from '@/components/ui/sonner';
import type { ApiSyncStatus } from '@/types';

/**
 * After an API write, say what the gateway actually did (guidelines §8: no optimistic "synced").
 * The API answers 200 even when the Tyk push failed or is still running, so success is only claimed
 * for `SYNCED`; `FAILED` shows the gateway error, and anything else — `PENDING`, or no status in the
 * body — says the save landed while the sync is unresolved. The page's sync badge keeps polling.
 */
export function toastSyncOutcome(
  t: ReturnType<typeof useTranslations>,
  result: { syncStatus?: ApiSyncStatus; syncError?: string | null } | null | undefined,
  savedMessage: string,
): void {
  if (result?.syncStatus === 'SYNCED') {
    toast.success(savedMessage);
  } else if (result?.syncStatus === 'FAILED') {
    toast.error(t('sync.savedButFailed', { saved: savedMessage, error: result.syncError ?? t('unknownGatewayError') }));
  } else {
    toast.warning(t('sync.savedButPending', { saved: savedMessage }));
  }
}
