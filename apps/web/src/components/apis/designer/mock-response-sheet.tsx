'use client';

import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm, type Control, type Resolver } from 'react-hook-form';
import { z } from 'zod';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { useUpdateApi, type ApiDefinition } from '@/hooks/use-apis';
import type { ApiConfig } from '@/types';
import { ConfigSheet, ConfigSheetFooter } from './config-sheet';
import { pairLines, pairsToLines, wholeNumber } from './list-codec';

type Translate = (key: string, values?: Record<string, string | number>) => string;

function makeSchema(t: Translate) {
  return z
    .object({
      enabled: z.boolean(),
      code: wholeNumber(t('designer.errors.wholeNumberInvalid'), t('designer.mock.codeRangeError'), 100, 599),
      body: z.string(),
      headers: pairLines(t('designer.headerTransform.addLineFormatError')),
    })
    .superRefine((values, ctx) => {
      if (values.enabled && values.body.trim() === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('designer.errors.required'), path: ['body'] });
      }
    });
}

type Input_ = z.input<ReturnType<typeof makeSchema>>;
type Values = z.infer<ReturnType<typeof makeSchema>>;

function toFormInput(api: ApiDefinition): Input_ {
  const mock = api.config?.mock;
  return {
    enabled: !!mock,
    code: String(mock?.code ?? 200),
    body: mock?.body ?? '',
    headers: pairsToLines(mock?.headers),
  };
}

interface MockResponseSheetProps {
  api: ApiDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** WP15b: short-circuits the request — the upstream is never called. */
export function MockResponseSheet({ api, open, onOpenChange }: MockResponseSheetProps) {
  const t = useTranslations('apis');
  const updateMutation = useUpdateApi(api.id);
  const schema = useMemo(() => makeSchema(t), [t]);
  const form = useForm<Input_, unknown, Values>({
    resolver: zodResolver(schema) as unknown as Resolver<Input_, unknown, Values>,
    defaultValues: toFormInput(api),
  });
  const control = form.control as unknown as Control<Input_>;
  const enabled = form.watch('enabled');

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const save = async (mock: ApiConfig['mock']) => {
    try {
      await updateMutation.mutateAsync({ config: { mock } });
      toast.success(t('designer.savedToast'));
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('designer.saveError'));
    }
  };

  const onSubmit = (values: Values) =>
    save(
      values.enabled
        ? { code: values.code, body: values.body, ...(values.headers.length ? { headers: values.headers } : {}) }
        : null,
    );

  return (
    <ConfigSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('designer.mock.title')}
      description={t('designer.mock.description')}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
          <FormField
            control={control}
            name="enabled"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <FormLabel>{t('designer.mock.enable')}</FormLabel>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </div>
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="code"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.mock.statusCode')}</FormLabel>
                <FormControl>
                  <Input {...field} inputMode="numeric" disabled={!enabled} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="body"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.mock.body')}</FormLabel>
                <FormControl>
                  <Textarea {...field} rows={4} disabled={!enabled} className="font-mono text-xs" placeholder='{"status":"ok"}' />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="headers"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.mock.headers')}</FormLabel>
                <FormControl>
                  <Textarea {...field} rows={2} disabled={!enabled} placeholder="Content-Type: application/json" />
                </FormControl>
                <FormDescription>{t('designer.headerTransform.addDescription')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <ConfigSheetFooter isSubmitting={form.formState.isSubmitting} onCancel={handleClose} />
        </form>
      </Form>
    </ConfigSheet>
  );
}
