'use client';

import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { toast } from '@/components/ui/sonner';
import { Switch } from '@/components/ui/switch';
import { ApiRequestError } from '@/lib/api-client';
import {
  DEFAULT_INTERVAL,
  isSpecFetchError,
  SPEC_INTERVALS,
  specErrorMessage,
  specUrlProblem,
  useSaveSpecSource,
  type SpecInterval,
  type SpecSourceStatus,
} from '@/lib/api/spec-source';

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Configured = Extract<SpecSourceStatus, { configured: true }>;

const INTERVAL_VALUES = SPEC_INTERVALS.map(String) as [string, ...string[]];

/** Editing keeps the stored URL when the field is left empty (the API never returns it in full). */
const makeSchema = (t: Translate, editing: boolean) =>
  z.object({
    url: z.string().superRefine((value, ctx) => {
      if (editing && value.trim() === '') return;
      const problem = specUrlProblem(value);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: t(problem) });
    }),
    intervalMinutes: z.enum(INTERVAL_VALUES),
    enabled: z.boolean(),
  });
type Values = z.infer<ReturnType<typeof makeSchema>>;

const defaultsOf = (source: Configured | null): Values => ({
  url: '',
  intervalMinutes: String(
    source && (SPEC_INTERVALS as readonly number[]).includes(source.intervalMinutes) ? source.intervalMinutes : DEFAULT_INTERVAL,
  ),
  enabled: source?.enabled ?? true,
});

interface SpecSourceSheetProps {
  apiId: string;
  /** The stored source when editing, null to set one up. */
  source: Configured | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SpecSourceSheet({ apiId, source, open, onOpenChange }: SpecSourceSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-sm">
        {open && <SpecSourceForm apiId={apiId} source={source} onOpenChange={onOpenChange} />}
      </SheetContent>
    </Sheet>
  );
}

function SpecSourceForm({ apiId, source, onOpenChange }: Omit<SpecSourceSheetProps, 'open'>) {
  const t = useTranslations('specSource');
  const tCommon = useTranslations('common');
  const save = useSaveSpecSource(apiId);
  const editing = source !== null;
  const schema = useMemo(() => makeSchema(t, editing), [t, editing]);
  const defaults = useMemo(() => defaultsOf(source), [source]);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults });

  const close = () => {
    form.reset(defaults);
    onOpenChange(false);
  };

  const onSubmit = async (v: Values) => {
    const url = v.url.trim();
    try {
      await save.mutateAsync({
        ...(url ? { url } : {}),
        intervalMinutes: Number(v.intervalMinutes) as SpecInterval,
        enabled: v.enabled,
      });
      toast.success(t('sheet.savedToast'));
      close();
    } catch (error) {
      // A refused URL is explained on the field itself; anything else as a translated toast (never the URL).
      if (isSpecFetchError(error) || (error instanceof ApiRequestError && error.code === 'SPEC_SOURCE_URL_REQUIRED')) {
        form.setError('url', { message: specErrorMessage(t, error, 'errors.saveFailed') }, { shouldFocus: true });
      } else {
        toast.error(specErrorMessage(t, error, 'errors.saveFailed'));
      }
    }
  };

  const isSubmitting = form.formState.isSubmitting;

  return (
    <>
      <SheetHeader>
        <SheetTitle>{editing ? t('sheet.editTitle') : t('sheet.createTitle')}</SheetTitle>
        <SheetDescription>{t('sheet.description')}</SheetDescription>
      </SheetHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
          <FormField
            control={form.control}
            name="url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('sheet.urlLabel')}</FormLabel>
                <FormControl>
                  {/* The URL may carry an access token: never offered to autofill, history or spell check. */}
                  <Input
                    {...field}
                    dir="ltr"
                    inputMode="url"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    placeholder="https://"
                    disabled={isSubmitting}
                  />
                </FormControl>
                {editing && (
                  <FormDescription>
                    {t('sheet.urlKeepHelp', { url: source.url })}
                  </FormDescription>
                )}
                <FormDescription>{t('sheet.urlHelp')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="intervalMinutes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('sheet.intervalLabel')}</FormLabel>
                <Select value={field.value} onValueChange={field.onChange} disabled={isSubmitting}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {SPEC_INTERVALS.map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {t(`intervals.${String(m)}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <FormItem className="flex items-start justify-between gap-4 space-y-0">
                <div className="min-w-0 space-y-0.5">
                  <FormLabel>{t('sheet.enabledLabel')}</FormLabel>
                  <FormDescription>{t('sheet.enabledHelp')}</FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} disabled={isSubmitting} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <p className="text-sm text-muted-foreground">{t('card.gatewayNote')}</p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="min-h-11" onClick={close} disabled={isSubmitting}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" className="min-h-11" loading={isSubmitting}>
              {t('sheet.save')}
            </Button>
          </div>
        </form>
      </Form>
    </>
  );
}
