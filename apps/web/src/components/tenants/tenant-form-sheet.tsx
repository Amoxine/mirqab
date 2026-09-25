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
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { toast } from '@/components/ui/sonner';
import { useCreateTenant, useUpdateTenant, type Tenant } from '@/hooks/use-tenants';

/** `t` is `useTranslations('tenants')` — messages need it, so this is a factory (called once via
 * `useMemo` below, not a static schema); the shape/validation logic still lives at module scope. */
function makeTenantFormSchema(t: (key: string) => string) {
  return z.object({
    name: z.string().min(2, t('form.errors.nameTooShort')).max(100),
    slug: z
      .string()
      .min(2)
      .max(100)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, t('form.errors.slugInvalid')),
    plan: z.enum(['FREE', 'STARTER', 'PRO', 'ENTERPRISE']),
  });
}
type TenantFormValues = z.infer<ReturnType<typeof makeTenantFormSchema>>;

type TenantFormSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & ({ mode: 'create' } | { mode: 'edit'; tenant: Tenant });

/** Create / edit sheet for a tenant. `mode="edit"` needs the `tenant` being edited. */
export function TenantFormSheet(props: TenantFormSheetProps) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        {/* Radix mounts the content only while open, so the form starts fresh every time. */}
        <TenantFormBody {...props} />
      </SheetContent>
    </Sheet>
  );
}

function TenantFormBody(props: TenantFormSheetProps) {
  const t = useTranslations('tenants');
  const tCommon = useTranslations('common');
  const { onOpenChange } = props;
  const tenant = props.mode === 'edit' ? props.tenant : undefined;
  const createMutation = useCreateTenant();
  const updateMutation = useUpdateTenant(tenant?.id ?? '');

  const tenantFormSchema = useMemo(() => makeTenantFormSchema(t), [t]);
  const form = useForm<TenantFormValues>({
    resolver: zodResolver(tenantFormSchema),
    defaultValues: {
      name: tenant?.name ?? '',
      slug: tenant?.slug ?? '',
      plan: tenant?.plan ?? 'FREE',
    },
  });

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (values: TenantFormValues) => {
    try {
      if (tenant) {
        // Slug is immutable once created — only name/plan can change here.
        await updateMutation.mutateAsync({ name: values.name, plan: values.plan });
        toast.success(t('form.updateSuccess'));
      } else {
        await createMutation.mutateAsync(values);
        toast.success(t('form.createSuccess'));
      }
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('form.saveFailed'));
    }
  };

  const isSubmitting = form.formState.isSubmitting;

  return (
    <>
      <SheetHeader>
        <SheetTitle>{tenant ? t('form.editTitle') : t('form.createTitle')}</SheetTitle>
        <SheetDescription>
          {tenant ? t('form.editDescription') : t('form.createDescription')}
        </SheetDescription>
      </SheetHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
            name="slug"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('fields.slug')}</FormLabel>
                <FormControl>
                  <Input {...field} placeholder={t('form.slugPlaceholder')} disabled={!!tenant} />
                </FormControl>
                {tenant && <FormDescription>{t('form.slugImmutable')}</FormDescription>}
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="plan"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('fields.plan')}</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={t('form.planPlaceholder')} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="FREE">{t('plan.FREE')}</SelectItem>
                    <SelectItem value="STARTER">{t('plan.STARTER')}</SelectItem>
                    <SelectItem value="PRO">{t('plan.PRO')}</SelectItem>
                    <SelectItem value="ENTERPRISE">{t('plan.ENTERPRISE')}</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={handleClose} disabled={isSubmitting}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {isSubmitting ? t('form.submitSaving') : tenant ? t('form.submitSave') : t('form.submitCreate')}
            </Button>
          </div>
        </form>
      </Form>
    </>
  );
}
