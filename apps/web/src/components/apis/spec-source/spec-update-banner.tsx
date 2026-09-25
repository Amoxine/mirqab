'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileDiff } from 'lucide-react';
import { useFormat } from '@/hooks/use-format';
import { usePermissions } from '@/hooks/use-permissions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSpecCandidates, useSpecSource } from '@/lib/api/spec-source';
import { SpecReviewSheet } from './spec-review-sheet';

/**
 * "A new version is available" for one API, with the counts stored at detection (the review Sheet
 * recomputes them against the current version). Gone as soon as the candidate is applied, dismissed
 * or superseded: those mutations invalidate `specCandidates`. Read-only users can view the diff (an
 * `api:read` route) but not use or dismiss it.
 */
export function SpecUpdateBanner({ apiId }: { apiId: string }) {
  const t = useTranslations('specSource');
  const fmt = useFormat();
  const { can } = usePermissions();
  const canUpdate = can('api:update');
  // Shares the source card's query: candidates are only read (and polled) for an API that watches a URL.
  const { data: source } = useSpecSource(apiId);
  const { data } = useSpecCandidates(apiId, source?.configured === true);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const pending = data?.pending;

  return (
    <>
      {pending && (
        <div
          role="status"
          className="flex flex-col gap-3 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 items-start gap-2">
            <FileDiff className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <div className="min-w-0 space-y-1">
              <p className="font-medium">{t('banner.title')}</p>
              <p>
                {t('banner.counts', { added: pending.diff.added, removed: pending.diff.removed, changed: pending.diff.changed })}
              </p>
              {(pending.diff.governedRemoved > 0 || pending.diff.governedChanged > 0) && (
                <p>{t('banner.governed', { removed: pending.diff.governedRemoved, changed: pending.diff.governedChanged })}</p>
              )}
              <p className="text-xs text-muted-foreground">{t('banner.detected', { date: fmt.dateTime(pending.detectedAt) })}</p>
            </div>
          </div>
          <Button type="button" variant="outline" className="min-h-11 shrink-0" onClick={() => { setReviewing(pending.id); }}>
            {canUpdate ? t('banner.review') : t('banner.view')}
          </Button>
        </div>
      )}
      <SpecReviewSheet
        apiId={apiId}
        candidateId={reviewing}
        canUpdate={canUpdate}
        onOpenChange={(open) => {
          if (!open) setReviewing(null);
        }}
      />
    </>
  );
}

/** "Update available" next to an API in a list; the row's `specUpdateAvailable` (GET /apis) decides. */
export function SpecUpdateBadge() {
  const t = useTranslations('specSource');
  return (
    <Badge variant="outline" className="border-warning/50 font-normal">
      {t('badge.updateAvailable')}
    </Badge>
  );
}
