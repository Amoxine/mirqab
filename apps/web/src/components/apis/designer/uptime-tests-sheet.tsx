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

type Translate = (key: string, values?: Record<string, string | number>) => string;
type UptimeTest = NonNullable<ApiConfig['uptimeTests']>[number];

const MAX_TESTS = 10;

/** "https://api/health GET 5" per line -> `{url, method?, timeoutSeconds?}[]`. Method and timeout are optional trailing tokens. */
function uptimeLines(t: Translate) {
  return z.string().transform((text, ctx) => {
    const out: UptimeTest[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const [url, method, timeout] = line.split(/\s+/);
      if (url === undefined || !/^https?:\/\//.test(url) || (timeout !== undefined && !/^\d+$/.test(timeout))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('designer.uptimeTests.lineFormatError') });
        return z.NEVER;
      }
      out.push({
        url,
        ...(method ? { method: method.toUpperCase() } : {}),
        ...(timeout ? { timeoutSeconds: Number(timeout) } : {}),
      });
    }
    if (out.length > MAX_TESTS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('designer.uptimeTests.tooManyError', { max: MAX_TESTS }) });
      return z.NEVER;
    }
    return out;
  });
}

function makeSchema(t: Translate) {
  return z.object({ tests: uptimeLines(t) });
}

type Input_ = z.input<ReturnType<typeof makeSchema>>;
type Values = z.infer<ReturnType<typeof makeSchema>>;

function toFormInput(api: ApiDefinition): Input_ {
  const tests = api.config?.uptimeTests ?? [];
  return {
    tests: tests
      .map((probe) => [probe.url, probe.method ?? '', probe.timeoutSeconds ? String(probe.timeoutSeconds) : ''].join(' ').trim())
      .join('\n'),
  };
}

interface UptimeTestsSheetProps {
  api: ApiDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** WP15a: probes the gateway runs on an interval to compute `healthStatus`. */
export function UptimeTestsSheet({ api, open, onOpenChange }: UptimeTestsSheetProps) {
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

  const save = async (uptimeTests: ApiConfig['uptimeTests']) => {
    try {
      await updateMutation.mutateAsync({ config: { uptimeTests } });
      toast.success(t('designer.savedToast'));
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('designer.saveError'));
    }
  };

  const onSubmit = (values: Values) => save(values.tests.length > 0 ? values.tests : null);

  return (
    <ConfigSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('designer.uptimeTests.title')}
      description={t('designer.uptimeTests.description')}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
          <FormField
            control={control}
            name="tests"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.uptimeTests.probes')}</FormLabel>
                <FormControl>
                  <Textarea {...field} rows={6} placeholder="https://orders:4000/health GET 5" />
                </FormControl>
                <FormDescription>{t('designer.uptimeTests.probesDescription', { max: MAX_TESTS })}</FormDescription>
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
