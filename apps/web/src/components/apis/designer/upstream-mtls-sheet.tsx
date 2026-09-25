'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { useCertificates } from '@/hooks/use-certificates';
import { useUpdateApi, type ApiDefinition } from '@/hooks/use-apis';
import { ConfigSheet, ConfigSheetFooter } from './config-sheet';
import { toastSyncOutcome } from '@/components/apis/sync-outcome-toast';

/** Radix Select forbids an empty-string item value, so "no certificate" needs a sentinel. */
const NONE = 'NONE';

const schema = z.object({ certificateId: z.string() });
type Values = z.infer<typeof schema>;

interface UpstreamMtlsSheetProps {
  api: ApiDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * WP26a (U19/U6) — presents a client certificate to this API's upstream when it demands one.
 * NOT client-certificate auth at the gateway (cut, O13): this is upstream-facing only.
 */
export function UpstreamMtlsSheet({ api, open, onOpenChange }: UpstreamMtlsSheetProps) {
  const t = useTranslations('apis');
  const updateMutation = useUpdateApi(api.id);
  const { data: certs, isLoading: certsLoading } = useCertificates();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { certificateId: api.config?.upstreamMutualTls?.certificateId ?? '' },
  });

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (values: Values) => {
    try {
      const saved = await updateMutation.mutateAsync({
        config: { upstreamMutualTls: values.certificateId ? { certificateId: values.certificateId } : null },
      });
      toastSyncOutcome(t, saved, t('designer.savedToast'));
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('designer.saveError'));
    }
  };

  return (
    <ConfigSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('designer.upstreamMtls.title')}
      description={t('designer.upstreamMtls.description')}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
          <FormField
            control={form.control}
            name="certificateId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.upstreamMtls.certificateLabel')}</FormLabel>
                <Select
                  onValueChange={(v) => {
                    field.onChange(v === NONE ? '' : v);
                  }}
                  value={field.value === '' ? NONE : field.value}
                  disabled={certsLoading}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue
                        placeholder={certsLoading ? t('designer.upstreamMtls.loading') : t('designer.upstreamMtls.placeholder')}
                      />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('designer.upstreamMtls.none')}</SelectItem>
                    {(certs ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.commonName ?? c.fingerprint.slice(0, 16)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>{t('designer.upstreamMtls.hint')}</FormDescription>
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
