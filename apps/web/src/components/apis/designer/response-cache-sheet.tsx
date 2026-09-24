'use client';

import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm, type Control, type Resolver } from 'react-hook-form';
import { Trash2 } from 'lucide-react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/sonner';
import { useInvalidateCache, useUpdateApi, type ApiDefinition } from '@/hooks/use-apis';
import type { ApiConfig } from '@/types';
import { ConfigSheet, ConfigSheetFooter } from './config-sheet';
import { csvNumbers, wholeNumber } from './list-codec';

type Translate = (key: string, values?: Record<string, string | number>) => string;

function makeSchema(t: Translate) {
  return z.object({
    enabled: z.boolean(),
    timeoutSeconds: wholeNumber(t('designer.errors.wholeNumberInvalid'), t('designer.errors.wholeNumberTooSmall', { min: 1 }), 1),
    cacheAllSafeRequests: z.boolean(),
    cacheResponseCodes: csvNumbers(t('designer.errors.wholeNumberInvalid')),
  });
}

type Input_ = z.input<ReturnType<typeof makeSchema>>;
type Values = z.infer<ReturnType<typeof makeSchema>>;

function toFormInput(api: ApiDefinition): Input_ {
  const cache = api.config?.cache;
  return {
    enabled: !!cache,
    timeoutSeconds: String(cache?.timeoutSeconds ?? 60),
    cacheAllSafeRequests: cache?.cacheAllSafeRequests ?? true,
    cacheResponseCodes: (cache?.cacheResponseCodes ?? []).join(', '),
  };
}

interface ResponseCacheSheetProps {
  api: ApiDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** WP15b: response caching, plus an on-demand invalidation action against the already-live cache. */
export function ResponseCacheSheet({ api, open, onOpenChange }: ResponseCacheSheetProps) {
  const t = useTranslations('apis');
  const updateMutation = useUpdateApi(api.id);
  const invalidateMutation = useInvalidateCache(api.id);
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

  const save = async (cache: ApiConfig['cache']) => {
    try {
      await updateMutation.mutateAsync({ config: { cache } });
      toast.success(t('designer.savedToast'));
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('designer.saveError'));
    }
  };

  const onSubmit = (values: Values) =>
    save(
      values.enabled
        ? {
            timeoutSeconds: values.timeoutSeconds,
            cacheAllSafeRequests: values.cacheAllSafeRequests,
            ...(values.cacheResponseCodes.length ? { cacheResponseCodes: values.cacheResponseCodes } : {}),
          }
        : null,
    );

  const handleInvalidate = async () => {
    try {
      const result = await invalidateMutation.mutateAsync();
      toast.success(
        result.invalidated
          ? t('designer.cache.invalidatedToast', { count: result.keysDropped })
          : t('designer.cache.invalidateNoOpToast'),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('designer.cache.invalidateError'));
    }
  };

  return (
    <ConfigSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('designer.cache.title')}
      description={t('designer.cache.description')}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
          <FormField
            control={control}
            name="enabled"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <FormLabel>{t('designer.cache.enable')}</FormLabel>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </div>
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="timeoutSeconds"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.cache.timeoutSeconds')}</FormLabel>
                <FormControl>
                  <Input {...field} inputMode="numeric" disabled={!enabled} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="cacheAllSafeRequests"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div className="min-w-0 space-y-0.5">
                    <FormLabel>{t('designer.cache.allSafeRequests')}</FormLabel>
                    <FormDescription>{t('designer.cache.allSafeRequestsDescription')}</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} disabled={!enabled} />
                  </FormControl>
                </div>
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="cacheResponseCodes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.cache.responseCodes')}</FormLabel>
                <FormControl>
                  <Input {...field} disabled={!enabled} placeholder="200, 301" />
                </FormControl>
                <FormDescription>{t('form.commaSeparated')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="rounded-md border p-3">
            <p className="text-sm font-medium">{t('designer.cache.invalidateNow')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('designer.cache.invalidateNowDescription')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={invalidateMutation.isPending}
              onClick={() => {
                void handleInvalidate();
              }}
            >
              <Trash2 className="me-2 h-4 w-4" />
              {invalidateMutation.isPending ? t('designer.cache.invalidating') : t('designer.cache.invalidateNow')}
            </Button>
          </div>

          <ConfigSheetFooter isSubmitting={form.formState.isSubmitting} onCancel={handleClose} />
        </form>
      </Form>
    </ConfigSheet>
  );
}
