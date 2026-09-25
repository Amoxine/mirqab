'use client';

import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/sonner';
import { QUOTA_PERIODS } from '@/components/keys/key-utils';
import { useSetTenantQuota, useTenantQuota, type TenantQuota } from '@/hooks/use-tenants';

/** `t` is `useTranslations('tenants')` — same factory pattern as `tenant-form-sheet.tsx`. */
function makeQuotaFormSchema(t: (key: string) => string) {
  return z.object({
    quotaMax: z
      .string()
      .refine((v) => /^-?\d+$/.test(v) && Number(v) >= -1, t('quota.errors.quotaMaxInvalid')),
    period: z.enum(QUOTA_PERIODS),
    isInactive: z.boolean(),
  });
}
type QuotaFormValues = z.infer<ReturnType<typeof makeQuotaFormSchema>>;

const defaultsFrom = (quota: TenantQuota | undefined): QuotaFormValues => ({
  quotaMax: quota?.quotaMax !== null && quota?.quotaMax !== undefined ? String(quota.quotaMax) : '-1',
  period: 'MONTHLY',
  isInactive: quota?.isInactive ?? false,
});

interface TenantQuotaSheetProps {
  tenantId: string;
  tenantName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Edit sheet for a tenant's org-level quota ceiling (U13/U14) — `PATCH /tenants/:id/quota`. */
export function TenantQuotaSheet({ tenantId, tenantName, open, onOpenChange }: TenantQuotaSheetProps) {
  const t = useTranslations('tenants');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>{t('quota.sheetTitle', { name: tenantName })}</SheetTitle>
          <SheetDescription>{t('quota.sheetDescription')}</SheetDescription>
        </SheetHeader>
        {/* Radix mounts content only while open, so the form (and its live defaults) starts fresh every time. */}
        {open && <QuotaForm tenantId={tenantId} onOpenChange={onOpenChange} />}
      </SheetContent>
    </Sheet>
  );
}

function QuotaForm({ tenantId, onOpenChange }: { tenantId: string; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('tenants');
  const tCommon = useTranslations('common');
  const { data: quota, isLoading } = useTenantQuota(tenantId);
  const setQuota = useSetTenantQuota(tenantId);

  const schema = useMemo(() => makeQuotaFormSchema(t), [t]);
  const form = useForm<QuotaFormValues>({
    resolver: zodResolver(schema),
    values: isLoading ? undefined : defaultsFrom(quota),
  });

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (values: QuotaFormValues) => {
    try {
      await setQuota.mutateAsync({
        quotaMax: Number(values.quotaMax),
        period: values.period,
        isInactive: values.isInactive,
      });
      toast.success(t('quota.saveSuccess'));
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('quota.saveFailed'));
    }
  };

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('quota.loading')}</p>;
  }

  const isSubmitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
        <FormField
          control={form.control}
          name="quotaMax"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('quota.quotaMaxLabel')}</FormLabel>
              <FormControl>
                <Input {...field} type="number" inputMode="numeric" min={-1} step={1} />
              </FormControl>
              <FormDescription>{t('quota.quotaMaxHint')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="period"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('quota.periodLabel')}</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {QUOTA_PERIODS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {t(`quota.periods.${p}`)}
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
          name="isInactive"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <FormLabel>{t('quota.isInactiveLabel')}</FormLabel>
                <FormDescription>{t('quota.isInactiveHint')}</FormDescription>
              </div>
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
            </FormItem>
          )}
        />
        <SheetFooter className="mt-auto gap-2 pt-2">
          <Button type="button" variant="outline" onClick={handleClose}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" loading={isSubmitting}>
            {isSubmitting ? t('quota.submitSaving') : t('quota.submitSave')}
          </Button>
        </SheetFooter>
      </form>
    </Form>
  );
}
