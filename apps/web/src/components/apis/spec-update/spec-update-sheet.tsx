'use client';

import { useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { toastSyncOutcome } from '@/components/apis/sync-outcome-toast';
import { toastApiError } from '@/components/apis/endpoints/api-error';
import { SpecSourceField, specSourceSchema } from '@/components/apis/import/spec-source-field';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { isStale, useSpecUpdate, type SpecUpdateResult } from '@/lib/api/openapi';
import { SpecDiffView } from './spec-diff-view';

type Translate = (key: string, values?: Record<string, string | number>) => string;

const makeSchema = (t: Translate) => z.object({ source: specSourceSchema(t), acknowledge: z.boolean() });
type Values = z.infer<ReturnType<typeof makeSchema>>;
const DEFAULTS: Values = { source: '', acknowledge: false };

interface SpecUpdateSheetProps {
  apiId: string;
  /** Latest stored version the user is looking at: the compare-and-set of the upload. 0 = no spec yet (creates version 1). */
  versionNo: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * OAS-04 re-upload: choose a document -> dry-run diff against the stored version (added / removed /
 * changed endpoints, which governed endpoints it affects, findings) -> apply. Removing an endpoint
 * that carries governance needs an explicit acknowledgement, because the gateway stops applying it.
 */
export function SpecUpdateSheet({ apiId, versionNo, open, onOpenChange }: SpecUpdateSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">
        {open && <SpecUpdateBody apiId={apiId} versionNo={versionNo} onOpenChange={onOpenChange} />}
      </SheetContent>
    </Sheet>
  );
}

function SpecUpdateBody({ apiId, versionNo, onOpenChange }: Omit<SpecUpdateSheetProps, 'open'>) {
  const t = useTranslations('openapi');
  const tApis = useTranslations('apis');
  const tCommon = useTranslations('common');
  const mutation = useSpecUpdate(apiId);
  const schema = useMemo(() => makeSchema(t), [t]);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: DEFAULTS });
  /** The dry run and the exact text + version it was computed for. */
  const [diff, setDiff] = useState<{ result: SpecUpdateResult; source: string; version: number } | null>(null);

  const [source, acknowledge] = useWatch({ control: form.control, name: ['source', 'acknowledge'] });
  const current = diff !== null && diff.source === source && diff.version === versionNo;
  const removedGoverned = current ? diff.result.governanceImpact.removedGoverned : [];
  const hasErrors = current && diff.result.findings.some((f) => f.severity === 'error');
  const canApply = current && !diff.result.unchanged && !hasErrors && (removedGoverned.length === 0 || acknowledge);

  const close = () => {
    form.reset(DEFAULTS);
    setDiff(null);
    onOpenChange(false);
  };

  const onSubmit = async (v: Values) => {
    try {
      if (!current) {
        const result = await mutation.mutateAsync({ source: v.source, expectedVersion: versionNo, dryRun: true });
        setDiff({ result, source: v.source, version: versionNo });
        form.setValue('acknowledge', false);
        return;
      }
      const result = await mutation.mutateAsync({
        source: v.source,
        expectedVersion: versionNo,
        dryRun: false,
        acknowledgeRemoved: removedGoverned.length > 0 && v.acknowledge,
      });
      // The API resyncs in the background after an apply: report the save, never a gateway success.
      toastSyncOutcome(tApis, undefined, t('specUpdate.appliedToast', { version: result.versionNo }));
      close();
    } catch (error) {
      // 409 SPEC_VERSION_STALE (the stored spec moved; the list reloads a new `versionNo`) or
      // SPEC_REMOVES_GOVERNED_ENDPOINTS (governance changed since the compare): the diff is no longer
      // what the user reviewed, so it is dropped. Each code has its own translated message.
      if (isStale(error)) setDiff(null);
      toastApiError(t, error, 'specUpdate.error');
    }
  };

  const isSubmitting = form.formState.isSubmitting;
  const r = current ? diff.result : null;

  return (
    <>
      <SheetHeader>
        <SheetTitle>{versionNo === 0 ? t('specUpdate.firstTitle') : t('specUpdate.title')}</SheetTitle>
        <SheetDescription>
          {versionNo === 0 ? t('specUpdate.firstDescription') : t('specUpdate.description', { version: versionNo })}
        </SheetDescription>
      </SheetHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
          <SpecSourceField
            control={form.control}
            name="source"
            disabled={isSubmitting}
            onFileError={(message) => {
              form.setError('source', { message });
            }}
          />
          {diff && !current && <p className="text-sm text-muted-foreground">{t('specUpdate.recompare')}</p>}

          {r && (
            <SpecDiffView
              result={r}
              acknowledge={
                <FormField
                  control={form.control}
                  name="acknowledge"
                  render={({ field }) => (
                    <FormItem className="flex items-start gap-2 space-y-0 pt-2">
                      <FormControl>
                        <Checkbox checked={field.value} onCheckedChange={(v) => { field.onChange(v === true); }} />
                      </FormControl>
                      <FormLabel className="font-normal">{t('specUpdate.acknowledge')}</FormLabel>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              }
            />
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={close} disabled={isSubmitting}>
              {r?.unchanged ? tCommon('close') : tCommon('cancel')}
            </Button>
            <Button type="submit" loading={isSubmitting} disabled={current && !canApply}>
              {current ? t('specUpdate.apply') : t('specUpdate.compare')}
            </Button>
          </div>
        </form>
      </Form>
    </>
  );
}
