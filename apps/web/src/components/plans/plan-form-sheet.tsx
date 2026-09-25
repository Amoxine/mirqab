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
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { QUOTA_PERIODS } from '@/components/keys/key-utils';
import { useCreatePlan, useUpdatePlan, type Plan } from '@/hooks/use-plans';

const wholeNumber = (t: (key: string) => string, errorKey: string, min: number) =>
  z.string().refine((v) => v === '' || (/^\d+$/.test(v) && Number(v) >= min), t(errorKey));

function makePlanFormSchema(t: (key: string) => string) {
  return z.object({
    name: z.string().trim().min(2, t('form.errors.nameTooShort')).max(60, t('form.errors.nameTooLong')),
    description: z.string().max(500).optional().or(z.literal('')),
    rate: wholeNumber(t, 'form.errors.rateInvalid', 0),
    per: wholeNumber(t, 'form.errors.perInvalid', 1),
    quotaMax: z.string().refine((v) => v === '' || (/^-?\d+$/.test(v) && Number(v) >= -1), t('form.errors.quotaInvalid')),
    quotaPeriod: z.enum(QUOTA_PERIODS),
    active: z.boolean(),
  });
}
type PlanFormValues = z.infer<ReturnType<typeof makePlanFormSchema>>;

const emptyValues: PlanFormValues = {
  name: '',
  description: '',
  rate: '',
  per: '',
  quotaMax: '',
  quotaPeriod: 'MONTHLY',
  active: true,
};

const valuesFromPlan = (plan: Plan): PlanFormValues => ({
  name: plan.name,
  description: plan.description ?? '',
  rate: plan.rate > 0 ? String(plan.rate) : '',
  per: plan.per > 0 ? String(plan.per) : '',
  quotaMax: plan.quotaMax >= 0 ? String(plan.quotaMax) : '-1',
  quotaPeriod: plan.quotaPeriod,
  active: plan.active,
});

type PlanFormSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & ({ mode: 'create' } | { mode: 'edit'; plan: Plan });

/** Create/edit sheet for a plan — a Tyk policy surfaced as a commercial rate/quota tier (U9). */
export function PlanFormSheet(props: PlanFormSheetProps) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <PlanFormBody {...props} />
      </SheetContent>
    </Sheet>
  );
}

function PlanFormBody(props: PlanFormSheetProps) {
  const t = useTranslations('plans');
  const tCommon = useTranslations('common');
  const { onOpenChange } = props;
  const plan = props.mode === 'edit' ? props.plan : undefined;
  const createMutation = useCreatePlan();
  const updateMutation = useUpdatePlan(plan?.id ?? '');

  const schema = useMemo(() => makePlanFormSchema(t), [t]);
  const form = useForm<PlanFormValues>({
    resolver: zodResolver(schema),
    defaultValues: plan ? valuesFromPlan(plan) : emptyValues,
  });

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (values: PlanFormValues) => {
    const payload = {
      name: values.name.trim(),
      description: (values.description ?? '').length > 0 ? values.description : undefined,
      rate: values.rate === '' ? 0 : Number(values.rate),
      per: values.per === '' ? 1 : Number(values.per),
      quotaMax: values.quotaMax === '' ? -1 : Number(values.quotaMax),
      quotaPeriod: values.quotaPeriod,
      active: values.active,
    };
    try {
      if (plan) {
        await updateMutation.mutateAsync(payload);
        toast.success(t('form.updateSuccess'));
      } else {
        await createMutation.mutateAsync(payload);
        toast.success(t('form.createSuccess'));
      }
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(plan ? 'form.updateFailed' : 'form.createFailed'));
    }
  };

  const isSubmitting = form.formState.isSubmitting;

  return (
    <>
      <SheetHeader>
        <SheetTitle>{plan ? t('form.editTitle') : t('form.createTitle')}</SheetTitle>
        <SheetDescription>{plan ? t('form.editDescription') : t('form.createDescription')}</SheetDescription>
      </SheetHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{tCommon('name')}</FormLabel>
                <FormControl>
                  <Input {...field} placeholder={t('form.namePlaceholder')} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('fields.description')}</FormLabel>
                <FormControl>
                  <Textarea {...field} rows={2} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="rate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('fields.rate')}</FormLabel>
                <FormControl>
                  <Input {...field} type="number" inputMode="numeric" min={0} step={1} placeholder={t('form.rateUnlimited')} />
                </FormControl>
                <FormDescription>{t('form.rateHint')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="per"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('fields.per')}</FormLabel>
                <FormControl>
                  <Input {...field} type="number" inputMode="numeric" min={1} step={1} placeholder="1" />
                </FormControl>
                <FormDescription>{t('form.perHint')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="quotaMax"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('fields.quotaMax')}</FormLabel>
                <FormControl>
                  <Input {...field} type="number" inputMode="numeric" min={-1} step={1} placeholder={t('form.quotaUnlimited')} />
                </FormControl>
                <FormDescription>{t('form.quotaMaxHint')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="quotaPeriod"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('fields.quotaPeriod')}</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {QUOTA_PERIODS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {t(`form.quotaPeriods.${p}`)}
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
            name="active"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between rounded-md border p-3">
                <div className="space-y-0.5">
                  <FormLabel>{t('fields.active')}</FormLabel>
                  <FormDescription>{t('form.activeHint')}</FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
          <SheetFooter className="mt-auto gap-2 pt-2">
            <Button type="button" variant="outline" onClick={handleClose} disabled={isSubmitting}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {plan
                ? t(isSubmitting ? 'form.submitSaving' : 'form.submitSave')
                : t(isSubmitting ? 'form.submitCreating' : 'form.submitCreate')}
            </Button>
          </SheetFooter>
        </form>
      </Form>
    </>
  );
}
