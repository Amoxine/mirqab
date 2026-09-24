'use client';

import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/sonner';
import { useUpdateApi, type ApiDefinition } from '@/hooks/use-apis';
import type { ApiConfig } from '@/types';
import { ConfigSheet, ConfigSheetFooter } from './config-sheet';

type Translate = (key: string) => string;

function makeSchema(t: Translate) {
  return z
    .object({
      enabled: z.boolean(),
      pattern: z.string(),
      rewriteTo: z.string(),
    })
    .superRefine((values, ctx) => {
      if (!values.enabled) return;
      if (values.pattern.trim() === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('designer.errors.required'), path: ['pattern'] });
      }
      if (values.rewriteTo.trim() === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('designer.errors.required'), path: ['rewriteTo'] });
      }
    });
}

type Values = z.infer<ReturnType<typeof makeSchema>>;

function toFormInput(api: ApiDefinition): Values {
  const rewrite = api.config?.urlRewrite;
  return { enabled: !!rewrite, pattern: rewrite?.pattern ?? '', rewriteTo: rewrite?.rewriteTo ?? '' };
}

interface UrlRewriteSheetProps {
  api: ApiDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** WP15b: rewrites the stripped request path before it reaches the upstream. */
export function UrlRewriteSheet({ api, open, onOpenChange }: UrlRewriteSheetProps) {
  const t = useTranslations('apis');
  const updateMutation = useUpdateApi(api.id);
  const schema = useMemo(() => makeSchema(t), [t]);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: toFormInput(api) });
  const enabled = form.watch('enabled');

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const save = async (urlRewrite: ApiConfig['urlRewrite']) => {
    try {
      await updateMutation.mutateAsync({ config: { urlRewrite } });
      toast.success(t('designer.savedToast'));
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('designer.saveError'));
    }
  };

  const onSubmit = (values: Values) =>
    save(values.enabled ? { pattern: values.pattern, rewriteTo: values.rewriteTo } : null);

  return (
    <ConfigSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('designer.urlRewrite.title')}
      description={t('designer.urlRewrite.description')}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
          <FormField
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <FormLabel>{t('designer.urlRewrite.enable')}</FormLabel>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </div>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="pattern"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.urlRewrite.pattern')}</FormLabel>
                <FormControl>
                  <Input {...field} disabled={!enabled} placeholder="/old/(.*)" />
                </FormControl>
                <FormDescription>{t('designer.urlRewrite.patternDescription')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="rewriteTo"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.urlRewrite.rewriteTo')}</FormLabel>
                <FormControl>
                  <Input {...field} disabled={!enabled} placeholder="/new/$1" />
                </FormControl>
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
