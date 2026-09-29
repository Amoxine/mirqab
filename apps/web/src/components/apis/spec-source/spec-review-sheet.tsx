'use client';

import { Notice } from '@open-gateway/ui';
import { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { toastSyncOutcome } from '@/components/apis/sync-outcome-toast';
import { SpecDiffView } from '@/components/apis/spec-update/spec-diff-view';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { ApiRequestError } from '@/lib/api-client';
import {
  isReviewStale,
  specErrorMessage,
  useApplyCandidate,
  useCandidateDiff,
  useDismissCandidate,
} from '@/lib/api/spec-source';

const schema = z.object({ acknowledge: z.boolean() });
type Values = z.infer<typeof schema>;
const DEFAULTS: Values = { acknowledge: false };

interface SpecReviewSheetProps {
  apiId: string;
  /** The detected version to review; null = closed. */
  candidateId: string | null;
  canUpdate: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * OAS-08 review of a detected version: the API recomputes the OAS-04 diff against the CURRENT stored
 * version (never the summary stored at detection), and "Use this version" compare-and-sets on the
 * `versionNo` of exactly that diff. A 409 means what was reviewed is no longer current: re-diff, say why.
 */
export function SpecReviewSheet({ apiId, candidateId, canUpdate, onOpenChange }: SpecReviewSheetProps) {
  return (
    <Sheet open={candidateId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">
        {candidateId !== null && (
          <ReviewBody apiId={apiId} candidateId={candidateId} canUpdate={canUpdate} onOpenChange={onOpenChange} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function ReviewBody({ apiId, candidateId, canUpdate, onOpenChange }: SpecReviewSheetProps & { candidateId: string }) {
  const t = useTranslations('specSource');
  const tApis = useTranslations('apis');
  const tCommon = useTranslations('common');
  const tOpenapi = useTranslations('openapi');
  const diff = useCandidateDiff(apiId, candidateId);
  const apply = useApplyCandidate(apiId);
  const dismiss = useDismissCandidate(apiId);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: DEFAULTS });
  const acknowledge = useWatch({ control: form.control, name: 'acknowledge' });
  const [staleReason, setStaleReason] = useState<string | null>(null);

  const close = () => {
    form.reset(DEFAULTS);
    setStaleReason(null);
    onOpenChange(false);
  };

  const r = diff.data;
  const removedGoverned = r?.governanceImpact.removedGoverned ?? [];
  const hasErrors = r?.findings.some((f) => f.severity === 'error') ?? false;
  const busy = form.formState.isSubmitting || dismiss.isPending;
  // What the acknowledgement was given for: a refetch that changes the version or the removed set
  // un-ticks it, so `acknowledgeRemoved` is never sent for removals the user did not see.
  const ackScope = r ? `${String(r.versionNo)}|${removedGoverned.map((g) => g.key).sort().join(',')}` : '';
  useEffect(() => {
    form.setValue('acknowledge', false);
  }, [ackScope, form]);
  const canApply = !!r && !diff.isFetching && !r.unchanged && !hasErrors && (removedGoverned.length === 0 || acknowledge);

  const onSubmit = async (v: Values) => {
    if (!r) return;
    try {
      const result = await apply.mutateAsync({
        candidateId,
        expectedVersion: r.versionNo,
        acknowledgeRemoved: removedGoverned.length > 0 && v.acknowledge,
      });
      if (!result.applied) {
        // The same content was stored meanwhile (e.g. uploaded by hand): nothing changed, nothing resyncs.
        // The hook still reloads the API, so the banner goes.
        toast.info(t('review.alreadyCurrent'));
      } else {
        // The gateway changes only through the resync that follows: report the save, never a sync success.
        toastSyncOutcome(tApis, undefined, t('review.appliedToast', { version: result.versionNo }));
      }
      close();
    } catch (error) {
      if (isReviewStale(error)) {
        setStaleReason(specErrorMessage(t, error, 'errors.applyFailed'));
        // The hook's onError re-fetches this API (the diff included): the user reviews the new state.
        form.setValue('acknowledge', false);
        return;
      }
      toast.error(specErrorMessage(t, error, 'errors.applyFailed'));
    }
  };

  const onDismiss = async () => {
    try {
      await dismiss.mutateAsync(candidateId);
      toast.success(t('review.dismissedToast'));
      close();
    } catch (error) {
      toast.error(specErrorMessage(t, error, 'errors.dismissFailed'));
    }
  };

  // 404: the candidate is gone; 409 CANDIDATE_STALE: it is no longer the pending one (used, dismissed, replaced).
  const gone =
    diff.error instanceof ApiRequestError && (diff.error.status === 404 || diff.error.code === 'CANDIDATE_STALE');

  return (
    <>
      <SheetHeader>
        <SheetTitle>{t('review.title')}</SheetTitle>
        <SheetDescription>{r ? t('review.description', { version: r.versionNo }) : t('card.gatewayNote')}</SheetDescription>
      </SheetHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
          {staleReason && (
            <Notice role="alert">
              <span className="break-words">{staleReason}</span>
            </Notice>
          )}

          {diff.isPending ? (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : diff.isError ? (
            <div role="alert" className="space-y-3 text-sm">
              <p>{gone ? t('review.gone') : specErrorMessage(t, diff.error, 'errors.diffFailed')}</p>
              {!gone && (
                <Button type="button" variant="outline" className="min-h-11" onClick={() => void diff.refetch()}>
                  {tCommon('retry')}
                </Button>
              )}
            </div>
          ) : (
            <SpecDiffView
              result={diff.data}
              acknowledge={
                canUpdate ? (
                  <FormField
                    control={form.control}
                    name="acknowledge"
                    render={({ field }) => (
                      <FormItem className="flex items-start gap-2 space-y-0 pt-2">
                        <FormControl>
                          <Checkbox checked={field.value} onCheckedChange={(c) => { field.onChange(c === true); }} disabled={busy} />
                        </FormControl>
                        <FormLabel className="font-normal">{tOpenapi('specUpdate.acknowledge')}</FormLabel>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ) : undefined
              }
            />
          )}

          <p className="text-sm text-muted-foreground">{canUpdate ? t('review.dismissHelp') : t('review.readOnly')}</p>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="min-h-11" onClick={close} disabled={busy}>
              {tCommon('close')}
            </Button>
            {canUpdate && !gone && (
              <>
                <Button type="button" variant="outline" className="min-h-11" onClick={() => void onDismiss()} loading={dismiss.isPending} disabled={busy}>
                  {t('review.dismiss')}
                </Button>
                <Button type="submit" className="min-h-11" loading={form.formState.isSubmitting} disabled={!canApply || busy}>
                  {t('review.apply')}
                </Button>
              </>
            )}
          </div>
        </form>
      </Form>
    </>
  );
}
