'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { AnalyticsErrorState } from '@/components/analytics/analytics-empty-state';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuditLog } from '@/hooks/use-audit-log';
import { useFormat } from '@/hooks/use-format';
import { useLastDefined } from '@/hooks/use-last-defined';
import { auditActionLabel } from '@/lib/audit-actions';
import { maskInternalDetails } from '@/lib/audit-details-display';
import { focusReturn } from '@/lib/focus-return';

/** One audit entry in full: what happened, who did it, on what, when and from where, and the recorded details. */
export function AuditDetailSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  // The URL empties the moment the sheet starts closing, but it takes a moment to animate out: it keeps
  // showing the entry it had, instead of an empty panel sliding away.
  const shown = useLastDefined(id);
  return (
    <Sheet
      open={id !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-xl"
        // Focus goes back to that entry's link in the list (a click on the row's text never focused
        // anything), or to the page when the entry is not listed, as when it was opened by a link.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusReturn(shown === null ? null : `audit:${shown}`);
        }}
      >
        {/* The content mounts only while the sheet is open, so nothing is requested for a closed one. */}
        {shown !== null && <EntryDetail id={shown} />}
      </SheetContent>
    </Sheet>
  );
}

function EntryDetail({ id }: { id: string }) {
  const t = useTranslations('analytics');
  const fmt = useFormat();
  const { data, isLoading, error, refetch } = useAuditLog(id);
  const detailsId = useId();

  return (
    <>
      <SheetHeader>
        <SheetTitle>{t('auditLogs.detail.title')}</SheetTitle>
        <SheetDescription>{t('auditLogs.detail.description')}</SheetDescription>
      </SheetHeader>
      <div className="mt-4 space-y-5">
        {isLoading && <Skeleton className="h-48 w-full" aria-busy="true" />}
        {error && (
          <AnalyticsErrorState message={t('auditLogs.detail.loadError')} onRetry={() => void refetch()} />
        )}
        {data && (
          <>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t('auditLogs.action')}</dt>
              <dd>
                <Badge variant="outline">{auditActionLabel(t, data.action)}</Badge>
              </dd>
              <dt className="text-muted-foreground">{t('auditLogs.columns.user')}</dt>
              <dd className="min-w-0 break-words">
                {data.user ? (
                  <>
                    {data.user.name && <span className="block">{data.user.name}</span>}
                    <span dir="ltr" className="text-muted-foreground block text-xs">
                      {data.user.email}
                    </span>
                  </>
                ) : (
                  t('auditLogs.systemUser')
                )}
              </dd>
              <dt className="text-muted-foreground">{t('auditLogs.columns.resource')}</dt>
              <dd>
                <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{data.resource}</code>
              </dd>
              <dt className="text-muted-foreground">{t('auditLogs.columns.timestamp')}</dt>
              <dd>
                <time dateTime={data.createdAt}>{fmt.dateTime(data.createdAt)}</time>
              </dd>
              {data.ipAddress && (
                <>
                  <dt className="text-muted-foreground">{t('auditLogs.columns.ipAddress')}</dt>
                  <dd dir="ltr" className="font-mono text-xs">
                    {data.ipAddress}
                  </dd>
                </>
              )}
              {data.corrId && (
                <>
                  <dt className="text-muted-foreground">{t('auditLogs.detail.correlationId')}</dt>
                  <dd dir="ltr" className="break-all font-mono text-xs">
                    {data.corrId}
                  </dd>
                </>
              )}
            </dl>
            <section className="space-y-2">
              <h3 id={detailsId} className="text-sm font-medium">
                {t('auditLogs.detail.details')}
              </h3>
              {data.details && Object.keys(data.details).length > 0 ? (
                // Scrollable, so a keyboard must be able to focus it, and a focus stop needs a name.
                // Shown with the platform's internal addressing hidden; the stored entry is unchanged.
                <pre
                  dir="ltr"
                  role="region"
                  aria-labelledby={detailsId}
                  tabIndex={0}
                  className="bg-muted max-h-96 overflow-auto rounded-md p-3 text-xs leading-relaxed"
                >
                  {JSON.stringify(maskInternalDetails(data.details), null, 2)}
                </pre>
              ) : (
                <p className="text-muted-foreground text-sm">{t('auditLogs.detail.noDetails')}</p>
              )}
            </section>
          </>
        )}
      </div>
    </>
  );
}
