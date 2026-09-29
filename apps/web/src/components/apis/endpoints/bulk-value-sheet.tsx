'use client';

import { Notice } from '@open-gateway/ui';
import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { EndpointGovernanceInput } from '@/lib/api/openapi';
import { makeGovernanceSchema, toFormValues, toPatch, type GovernanceFormValues } from './governance-form';

export type BulkValueControl = 'rateLimit' | 'timeoutSeconds' | 'requestSizeLimitBytes' | 'cache';

/** The governance form's on-switch and text fields for each bulk-settable control (one schema, reused). */
const FIELDS: Record<BulkValueControl, { on: keyof GovernanceFormValues; fields: (keyof GovernanceFormValues)[] }> = {
  rateLimit: { on: 'rateLimitOn', fields: ['rate', 'per'] },
  timeoutSeconds: { on: 'timeoutOn', fields: ['timeoutSeconds'] },
  requestSizeLimitBytes: { on: 'sizeOn', fields: ['sizeBytes'] },
  cache: { on: 'cacheOn', fields: ['cacheTimeout', 'cacheCodes'] },
};

const LABEL: Partial<Record<keyof GovernanceFormValues, string>> = {
  rate: 'governance.rate',
  per: 'governance.perSeconds',
  timeoutSeconds: 'governance.seconds',
  sizeBytes: 'governance.bytes',
  cacheTimeout: 'governance.seconds',
  cacheCodes: 'governance.cacheCodes',
};

interface BulkValueSheetProps {
  control: BulkValueControl | null;
  count: number;
  onOpenChange: (open: boolean) => void;
  /** Sends the PATCH for the selected keys; resolves true when saved (the sheet then closes). */
  onApply: (set: EndpointGovernanceInput) => Promise<boolean>;
}

/** Sets ONE valued control (rate limit, timeout, size limit, cache) on every selected endpoint. */
export function BulkValueSheet(props: BulkValueSheetProps) {
  return (
    <Sheet open={props.control !== null} onOpenChange={props.onOpenChange}>
      <SheetContent className="w-full sm:max-w-sm">
        {props.control && <BulkBody {...props} control={props.control} />}
      </SheetContent>
    </Sheet>
  );
}

function BulkBody({ control, count, onOpenChange, onApply }: BulkValueSheetProps & { control: BulkValueControl }) {
  const t = useTranslations('openapi');
  const tCommon = useTranslations('common');
  const schema = useMemo(() => makeGovernanceSchema(t), [t]);
  const spec = FIELDS[control];
  const form = useForm<GovernanceFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { ...toFormValues(null), [spec.on]: true },
  });

  const close = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (values: GovernanceFormValues) => {
    const { set } = toPatch(values, null, (c) => c === control);
    if (await onApply(set)) close();
  };

  const isSubmitting = form.formState.isSubmitting;
  return (
    <>
      <SheetHeader>
        <SheetTitle>{t(`bulk.set.${control}`)}</SheetTitle>
        <SheetDescription>{t('bulk.appliesTo', { count })}</SheetDescription>
      </SheetHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {control === 'rateLimit' && <Notice>{t('governance.rateLimitShared')}</Notice>}
          {spec.fields.map((name) => (
            <FormField
              key={name}
              control={form.control}
              name={name}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t(LABEL[name] ?? name)}</FormLabel>
                  <FormControl>
                    <Input {...field} value={String(field.value)} />
                  </FormControl>
                  {name === 'cacheCodes' && <FormDescription>{t('governance.commaSeparated')}</FormDescription>}
                  <FormMessage />
                </FormItem>
              )}
            />
          ))}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={close} disabled={isSubmitting}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {t('bulk.apply')}
            </Button>
          </div>
        </form>
      </Form>
    </>
  );
}
