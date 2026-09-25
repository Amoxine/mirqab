'use client';

import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm, type Control, type Resolver } from 'react-hook-form';
import { z } from 'zod';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { useUpdateApi, type ApiDefinition } from '@/hooks/use-apis';
import type { ApiConfig } from '@/types';
import { ConfigSheet, ConfigSheetFooter } from './config-sheet';
import { arrayToLines, linesToArray, pairLines, pairsToLines } from './list-codec';
import { toastSyncOutcome } from '@/components/apis/sync-outcome-toast';

type Translate = (key: string, values?: Record<string, string | number>) => string;

function makeSchema(t: Translate) {
  const invalid = t('designer.headerTransform.addLineFormatError');
  return z.object({
    requestAdd: pairLines(invalid),
    requestRemove: linesToArray,
    responseAdd: pairLines(invalid),
    responseRemove: linesToArray,
  });
}

type Input_ = z.input<ReturnType<typeof makeSchema>>;
type Values = z.infer<ReturnType<typeof makeSchema>>;

function toFormInput(api: ApiDefinition): Input_ {
  const req = api.config?.transformRequestHeaders;
  const res = api.config?.transformResponseHeaders;
  return {
    requestAdd: pairsToLines(req?.add),
    requestRemove: arrayToLines(req?.remove),
    responseAdd: pairsToLines(res?.add),
    responseRemove: arrayToLines(res?.remove),
  };
}

/** `{add, remove}` built from parsed lines, or `null` when both are empty (clears the section). */
function buildHeaderSection(
  add: { name: string; value: string }[],
  remove: string[],
): NonNullable<ApiConfig['transformRequestHeaders']> | null {
  if (add.length === 0 && remove.length === 0) return null;
  return { ...(add.length > 0 ? { add } : {}), ...(remove.length > 0 ? { remove } : {}) };
}

interface HeaderTransformSheetProps {
  api: ApiDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** WP15b: headers injected into / stripped from the request before the upstream sees it, and from
 * the response before the caller sees it. */
export function HeaderTransformSheet({ api, open, onOpenChange }: HeaderTransformSheetProps) {
  const t = useTranslations('apis');
  const updateMutation = useUpdateApi(api.id);
  const schema = useMemo(() => makeSchema(t), [t]);
  const form = useForm<Input_, unknown, Values>({
    resolver: zodResolver(schema) as unknown as Resolver<Input_, unknown, Values>,
    defaultValues: toFormInput(api),
  });
  const control = form.control as unknown as Control<Input_>;

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const save = async (config: {
    transformRequestHeaders: ApiConfig['transformRequestHeaders'];
    transformResponseHeaders: ApiConfig['transformResponseHeaders'];
  }) => {
    try {
      const saved = await updateMutation.mutateAsync({ config });
      toastSyncOutcome(t, saved, t('designer.savedToast'));
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('designer.saveError'));
    }
  };

  const onSubmit = (values: Values) =>
    save({
      transformRequestHeaders: buildHeaderSection(values.requestAdd, values.requestRemove),
      transformResponseHeaders: buildHeaderSection(values.responseAdd, values.responseRemove),
    });

  return (
    <ConfigSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('designer.headerTransform.title')}
      description={t('designer.headerTransform.description')}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-6">
          <div className="space-y-4">
            <h3 className="text-sm font-medium">{t('designer.headerTransform.request')}</h3>
            <FormField
              control={control}
              name="requestAdd"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('designer.headerTransform.add')}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3} placeholder="X-Request-Source: open-gateway" />
                  </FormControl>
                  <FormDescription>{t('designer.headerTransform.addDescription')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name="requestRemove"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('designer.headerTransform.remove')}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={2} placeholder="X-Internal-Token" />
                  </FormControl>
                  <FormDescription>{t('designer.headerTransform.removeDescription')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="space-y-4">
            <h3 className="text-sm font-medium">{t('designer.headerTransform.response')}</h3>
            <FormField
              control={control}
              name="responseAdd"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('designer.headerTransform.add')}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3} placeholder="X-Served-By: open-gateway" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name="responseRemove"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('designer.headerTransform.remove')}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={2} placeholder="X-Upstream-Debug" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <ConfigSheetFooter
            isSubmitting={form.formState.isSubmitting}
            onCancel={handleClose}
            onClear={() => {
              void save({ transformRequestHeaders: null, transformResponseHeaders: null });
            }}
          />
        </form>
      </Form>
    </ConfigSheet>
  );
}
