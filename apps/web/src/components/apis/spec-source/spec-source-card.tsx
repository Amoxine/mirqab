'use client';

import { ConfirmDialog } from '@open-gateway/ui';
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Link2, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { useFormat } from '@/hooks/use-format';
import {
  fetchErrorKey,
  SPEC_INTERVALS,
  specErrorMessage,
  useCheckSpecSource,
  useRemoveSpecSource,
  useSpecSource,
  type SpecSourceStatus,
} from '@/lib/api/spec-source';
import { SpecSourceSheet } from './spec-source-sheet';

type Configured = Extract<SpecSourceStatus, { configured: true }>;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

/**
 * OAS-08 "Spec source" on the Endpoints tab: the watched URL (redacted by the API), its schedule and
 * the last check, with "Check now", "Edit source" (a Sheet) and "Remove" (confirmed). A check only
 * stores a detected version; the gateway changes when someone uses it.
 */
export function SpecSourceCard({ apiId, canUpdate }: { apiId: string; canUpdate: boolean }) {
  const t = useTranslations('specSource');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  const { data, isPending, isError, refetch } = useSpecSource(apiId);
  const check = useCheckSpecSource(apiId);
  const remove = useRemoveSpecSource(apiId);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  if (isPending) return <Skeleton className="h-28 w-full" />;

  const source: Configured | null = data?.configured === true ? data : null;
  const reason = (code: string | null | undefined) => {
    const { key, values } = fetchErrorKey(code);
    return t(key, values);
  };

  const onCheck = async () => {
    try {
      const outcome = await check.mutateAsync();
      if (outcome.result === 'CHANGED') toast.info(t('check.changedToast'));
      else if (outcome.result === 'UNCHANGED') toast.success(t('check.unchangedToast'));
      else toast.error(t('check.errorToast', { reason: reason(outcome.errorCode) }));
    } catch (error) {
      toast.error(specErrorMessage(t, error, 'errors.checkFailed'));
    }
  };

  const onRemove = async () => {
    try {
      await remove.mutateAsync();
      toast.success(t('remove.removedToast'));
    } catch (error) {
      toast.error(specErrorMessage(t, error, 'errors.removeFailed'));
    }
  };

  const when = (value: string | null) => (value ? fmt.dateTime(value) : t('card.never'));

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-0.5">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <Link2 className="text-muted-foreground h-4 w-4" aria-hidden="true" />
              {t('card.title')}
            </h3>
            <p className="text-muted-foreground text-sm">
              {source ? t('card.gatewayNote') : t('card.notConfigured')}
            </p>
          </div>
          {canUpdate && !source && !isError && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 shrink-0"
              onClick={() => {
                setEditOpen(true);
              }}
            >
              {t('card.setUp')}
            </Button>
          )}
        </div>

        {isError && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
            <p className="text-destructive">{t('card.loadError')}</p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => void refetch()}
            >
              {tCommon('retry')}
            </Button>
          </div>
        )}

        {source && (
          <>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label={t('card.url')}>
                <span dir="ltr" className="break-all font-mono text-xs">
                  {source.url}
                </span>
              </Field>
              <Field label={t('card.state')}>
                <Badge variant={source.enabled ? 'secondary' : 'outline'} className="font-normal">
                  {source.enabled ? t('card.enabled') : t('card.paused')}
                </Badge>
              </Field>
              <Field label={t('card.interval')}>
                {(SPEC_INTERVALS as readonly number[]).includes(source.intervalMinutes)
                  ? t(`intervals.${String(source.intervalMinutes)}`)
                  : fmt.number(source.intervalMinutes)}
              </Field>
              <Field label={t('card.lastResult')}>
                <span className={source.lastResult === 'ERROR' ? 'text-destructive' : undefined}>
                  {source.lastResult === null
                    ? t('card.never')
                    : t(`card.result.${source.lastResult}`, {
                        reason: reason(source.lastErrorCode),
                      })}
                </span>
                {source.consecutiveFailures > 1 && (
                  <span className="text-muted-foreground block text-xs">
                    {t('card.failures', { count: source.consecutiveFailures })}
                  </span>
                )}
              </Field>
              <Field label={t('card.lastChecked')}>{when(source.lastCheckedAt)}</Field>
              <Field label={t('card.nextCheck')}>
                {source.enabled ? when(source.nextCheckAt) : '—'}
              </Field>
            </dl>
            {canUpdate && (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  loading={check.isPending}
                  onClick={() => void onCheck()}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  {t('card.checkNow')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    setEditOpen(true);
                  }}
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  {t('card.edit')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive min-h-11"
                  loading={remove.isPending}
                  onClick={() => {
                    setConfirmRemove(true);
                  }}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  {t('card.remove')}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>

      <SpecSourceSheet apiId={apiId} source={source} open={editOpen} onOpenChange={setEditOpen} />
      <ConfirmDialog
        buttonClassName="min-h-11"
        tone="default"
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t('remove.confirmTitle')}
        description={t('remove.confirmBody')}
        confirmLabel={t('remove.confirm')}
        cancelLabel={tCommon('cancel')}
        onConfirm={() => {
          setConfirmRemove(false);
          void onRemove();
        }}
      />
    </Card>
  );
}
