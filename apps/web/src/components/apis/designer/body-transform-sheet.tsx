'use client';

import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { useUpdateApi, type ApiDefinition } from '@/hooks/use-apis';
import type { ApiConfig } from '@/types';
import { ConfigSheet, ConfigSheetFooter } from './config-sheet';

const FORMATS = ['json', 'xml'] as const;

type Translate = (key: string) => string;

function makeSchema(t: Translate) {
  return z
    .object({
      requestEnabled: z.boolean(),
      requestFormat: z.enum(FORMATS),
      requestBody: z.string(),
      responseEnabled: z.boolean(),
      responseFormat: z.enum(FORMATS),
      responseBody: z.string(),
    })
    .superRefine((values, ctx) => {
      if (values.requestEnabled && values.requestBody.trim() === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('designer.errors.required'), path: ['requestBody'] });
      }
      if (values.responseEnabled && values.responseBody.trim() === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('designer.errors.required'), path: ['responseBody'] });
      }
    });
}

type Values = z.infer<ReturnType<typeof makeSchema>>;

function toFormInput(api: ApiDefinition): Values {
  const req = api.config?.transformRequestBody;
  const res = api.config?.transformResponseBody;
  return {
    requestEnabled: !!req,
    requestFormat: req?.format ?? 'json',
    requestBody: req?.body ?? '',
    responseEnabled: !!res,
    responseFormat: res?.format ?? 'json',
    responseBody: res?.body ?? '',
  };
}

interface BodyTransformSheetProps {
  api: ApiDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** WP15b: a Go template applied to the request and/or response body. */
export function BodyTransformSheet({ api, open, onOpenChange }: BodyTransformSheetProps) {
  const t = useTranslations('apis');
  const updateMutation = useUpdateApi(api.id);
  const schema = useMemo(() => makeSchema(t), [t]);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: toFormInput(api) });
  const requestEnabled = form.watch('requestEnabled');
  const responseEnabled = form.watch('responseEnabled');

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const save = async (config: {
    transformRequestBody: ApiConfig['transformRequestBody'];
    transformResponseBody: ApiConfig['transformResponseBody'];
  }) => {
    try {
      await updateMutation.mutateAsync({ config });
      toast.success(t('designer.savedToast'));
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('designer.saveError'));
    }
  };

  const onSubmit = (values: Values) =>
    save({
      transformRequestBody: values.requestEnabled ? { format: values.requestFormat, body: values.requestBody } : null,
      transformResponseBody: values.responseEnabled
        ? { format: values.responseFormat, body: values.responseBody }
        : null,
    });

  return (
    <ConfigSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('designer.bodyTransform.title')}
      description={t('designer.bodyTransform.description')}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-6">
          <div className="space-y-4">
            <FormField
              control={form.control}
              name="requestEnabled"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                    <FormLabel>{t('designer.bodyTransform.request')}</FormLabel>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </div>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="requestFormat"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('designer.bodyTransform.format')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value} disabled={!requestEnabled}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {FORMATS.map((format) => (
                        <SelectItem key={format} value={format}>
                          {format.toUpperCase()}
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
              name="requestBody"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('designer.bodyTransform.template')}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={4} disabled={!requestEnabled} className="font-mono text-xs" />
                  </FormControl>
                  <FormDescription>{t('designer.bodyTransform.templateDescription')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="space-y-4">
            <FormField
              control={form.control}
              name="responseEnabled"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                    <FormLabel>{t('designer.bodyTransform.response')}</FormLabel>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </div>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="responseFormat"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('designer.bodyTransform.format')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value} disabled={!responseEnabled}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {FORMATS.map((format) => (
                        <SelectItem key={format} value={format}>
                          {format.toUpperCase()}
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
              name="responseBody"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('designer.bodyTransform.template')}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={4} disabled={!responseEnabled} className="font-mono text-xs" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <ConfigSheetFooter isSubmitting={form.formState.isSubmitting} onCancel={handleClose} />
        </form>
      </Form>
    </ConfigSheet>
  );
}
