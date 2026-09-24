'use client';

import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm, type Control, type Resolver } from 'react-hook-form';
import { z } from 'zod';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { useUpdateApi, type ApiDefinition } from '@/hooks/use-apis';
import type { ApiConfig } from '@/types';
import { ConfigSheet, ConfigSheetFooter } from './config-sheet';

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** "http://host:port 5" per line -> `{url, weight}[]`. */
function targetLines(t: Translate) {
  return z.string().transform((text, ctx) => {
    const out: { url: string; weight: number }[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const tokens = line.split(/\s+/);
      const [url, weightText] = tokens;
      if (
        tokens.length !== 2 ||
        url === undefined ||
        weightText === undefined ||
        !/^\d+$/.test(weightText) ||
        !/^https?:\/\//.test(url)
      ) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('designer.loadBalancing.lineFormatError') });
        return z.NEVER;
      }
      out.push({ url, weight: Number(weightText) });
    }
    return out;
  });
}

function makeSchema(t: Translate) {
  return z.object({
    targets: targetLines(t),
    skipUnavailableHosts: z.boolean(),
  });
}

type Input_ = z.input<ReturnType<typeof makeSchema>>;
type Values = z.infer<ReturnType<typeof makeSchema>>;

function toFormInput(api: ApiDefinition): Input_ {
  const lb = api.config?.loadBalancing;
  return {
    targets: (lb?.targets ?? []).map((tgt) => `${tgt.url} ${String(tgt.weight)}`).join('\n'),
    skipUnavailableHosts: lb?.skipUnavailableHosts ?? false,
  };
}

interface LoadBalancingSheetProps {
  api: ApiDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** WP15a: extra upstream targets traffic is spread across, beyond the API's own proxyUrl. */
export function LoadBalancingSheet({ api, open, onOpenChange }: LoadBalancingSheetProps) {
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

  const save = async (loadBalancing: ApiConfig['loadBalancing']) => {
    try {
      await updateMutation.mutateAsync({ config: { loadBalancing } });
      toast.success(t('designer.savedToast'));
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('designer.saveError'));
    }
  };

  const onSubmit = (values: Values) =>
    save(
      values.targets.length > 0
        ? { targets: values.targets, skipUnavailableHosts: values.skipUnavailableHosts }
        : null,
    );

  return (
    <ConfigSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('designer.loadBalancing.title')}
      description={t('designer.loadBalancing.description')}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
          <FormField
            control={control}
            name="targets"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.loadBalancing.targets')}</FormLabel>
                <FormControl>
                  <Textarea {...field} rows={6} placeholder="http://orders-b:4000 5" />
                </FormControl>
                <FormDescription>{t('designer.loadBalancing.targetsDescription')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="skipUnavailableHosts"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div className="min-w-0 space-y-0.5">
                    <FormLabel>{t('designer.loadBalancing.skipUnavailable')}</FormLabel>
                    <FormDescription>{t('designer.loadBalancing.skipUnavailableDescription')}</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
          <ConfigSheetFooter
            isSubmitting={form.formState.isSubmitting}
            onCancel={handleClose}
            onClear={() => {
              void save(null);
            }}
          />
        </form>
      </Form>
    </ConfigSheet>
  );
}
