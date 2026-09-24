'use client';

import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { toast } from '@/components/ui/sonner';
import { useCreateKey, useUpdateKey, type KeyDetail } from '@/hooks/use-keys';
import {
  QUOTA_PERIODS,
  emptyKeyFormValues,
  makeCreateKeyFormSchema,
  makeKeyFormSchema,
  toCreatePayload,
  toUpdatePayload,
  valuesFromKey,
  type KeyFormValues,
} from './key-utils';

interface KeyFormSheetProps {
  mode: 'create' | 'edit';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Create only: APIs a key can be scoped to. */
  apis?: { id: string; name: string }[];
  apisLoading?: boolean;
  /** Create only: plans a key can be assigned (WP19, U11/U12) — a select, never required. */
  plans?: { id: string; name: string }[];
  plansLoading?: boolean;
  /** Edit only: the key being edited (with its live gateway limits). */
  keyData?: KeyDetail;
  /** Create only: receives the raw key, which the API returns exactly once. */
  onCreated?: (keyValue: string) => void;
}

type KeyFormProps = Omit<KeyFormSheetProps, 'open'>;

/** Radix Select forbids an empty-string item value, so "no plan" needs a sentinel. */
const NO_PLAN = 'NONE';

/**
 * Mounted only while the sheet is open, so every open starts from fresh defaults
 * (blank for create, the key's live values for edit).
 */
function KeyForm({
  mode,
  onOpenChange,
  apis = [],
  apisLoading = false,
  plans = [],
  plansLoading = false,
  keyData,
  onCreated,
}: KeyFormProps) {
  const t = useTranslations('keys');
  const tCommon = useTranslations('common');
  const createMutation = useCreateKey();
  const updateMutation = useUpdateKey();

  const schema = useMemo(
    () => (mode === 'create' ? makeCreateKeyFormSchema(t) : makeKeyFormSchema(t)),
    [mode, t],
  );
  const form = useForm<KeyFormValues>({
    resolver: zodResolver(schema),
    defaultValues: mode === 'edit' && keyData ? valuesFromKey(keyData) : emptyKeyFormValues,
  });
  const quotaLimit = form.watch('quotaLimit');
  const planId = form.watch('planId');
  // A key with a plan carries no inline limits — the plan's policy governs both (see CreateKeyDto).
  const hasPlan = mode === 'create' && planId !== '';

  const onSubmit = async (values: KeyFormValues) => {
    try {
      if (mode === 'create') {
        const created = await createMutation.mutateAsync(toCreatePayload(values));
        onCreated?.(created.keyValue);
        toast.success(t('form.createSuccess'));
      } else if (keyData) {
        await updateMutation.mutateAsync({ id: keyData.id, data: toUpdatePayload(values) });
        toast.success(t('form.updateSuccess'));
      }
      form.reset();
      onOpenChange(false);
    } catch (error) {
      // Surfaces the API's message, e.g. the 400 for an API that is not synced to the gateway yet.
      toast.error(
        error instanceof Error ? error.message : t(mode === 'create' ? 'form.createFailed' : 'form.updateFailed'),
      );
    }
  };

  const handleCancel = () => {
    form.reset();
    onOpenChange(false);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('form.nameLabel')}</FormLabel>
              <FormControl>
                <Input {...field} placeholder={t('form.namePlaceholder')} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {mode === 'create' ? (
          <FormField
            control={form.control}
            name="apiDefId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('form.apiLabel')}</FormLabel>
                <Select onValueChange={field.onChange} value={field.value} disabled={apisLoading}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={apisLoading ? t('form.apiLoading') : t('form.apiPlaceholder')} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {apis.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  {!apisLoading && apis.length === 0 ? t('form.noActiveApis') : t('form.apiSyncHint')}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : (
          <div className="space-y-1 text-sm">
            <p className="font-medium">{t('form.apiLabel')}</p>
            <p className="text-muted-foreground">{keyData?.apiDefName ?? '—'}</p>
            <p className="text-xs text-muted-foreground">{t('form.apiNotEditable')}</p>
          </div>
        )}

        {mode === 'create' ? (
          <FormField
            control={form.control}
            name="planId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('form.planLabel')}</FormLabel>
                <Select
                  onValueChange={(v) => {
                    field.onChange(v === NO_PLAN ? '' : v);
                    // A plan carries the key's rate/quota — clear any inline values so a leftover
                    // number in a now-disabled field can never be submitted alongside it.
                    if (v !== NO_PLAN) {
                      form.setValue('rateLimitPerSecond', '');
                      form.setValue('quotaLimit', '');
                    }
                  }}
                  value={field.value === '' ? NO_PLAN : field.value}
                  disabled={plansLoading}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={plansLoading ? t('form.planLoading') : t('form.planPlaceholder')} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NO_PLAN}>{t('form.noPlan')}</SelectItem>
                    {plans.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>{t('form.planHint')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : (
          <div className="space-y-1 text-sm">
            <p className="font-medium">{t('form.planLabel')}</p>
            <p className="text-muted-foreground">{keyData?.planName ?? t('form.noPlan')}</p>
            <p className="text-xs text-muted-foreground">{t('form.planNotEditable')}</p>
          </div>
        )}

        <FormField
          control={form.control}
          name="expiresAt"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('form.expiresLabel')}</FormLabel>
              <FormControl>
                <Input {...field} type="date" />
              </FormControl>
              <FormDescription>{t('form.expiresHint')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="rateLimitPerSecond"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('form.rateLimitLabel')}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  disabled={hasPlan}
                  placeholder={t('form.rateLimitPlaceholder')}
                />
              </FormControl>
              <FormDescription>{hasPlan ? t('form.limitsFromPlan') : t('form.rateLimitHint')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="quotaLimit"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('form.quotaLabel')}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  disabled={hasPlan}
                  placeholder={t('form.quotaPlaceholder')}
                />
              </FormControl>
              <FormDescription>{hasPlan ? t('form.limitsFromPlan') : t('form.quotaHint')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="quotaPeriod"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('form.quotaPeriodLabel')}</FormLabel>
              <Select onValueChange={field.onChange} value={field.value} disabled={hasPlan || quotaLimit === ''}>
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

        {mode === 'edit' && (
          <div
            role="note"
            className="flex items-start gap-2 rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 text-sm"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
            <p>{t('form.editQuotaWarning')}</p>
          </div>
        )}

        <SheetFooter className="mt-auto gap-2 pt-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={handleCancel}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {mode === 'create'
              ? t(form.formState.isSubmitting ? 'form.submitCreating' : 'form.submitCreate')
              : t(form.formState.isSubmitting ? 'form.submitSaving' : 'form.submitSave')}
          </Button>
        </SheetFooter>
      </form>
    </Form>
  );
}

/** Create/edit form for an API key, in a right-side Sheet. */
export function KeyFormSheet({ open, ...formProps }: KeyFormSheetProps) {
  const t = useTranslations('keys');
  const isCreate = formProps.mode === 'create';
  return (
    <Sheet open={open} onOpenChange={formProps.onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{isCreate ? t('form.createTitle') : t('form.editTitle')}</SheetTitle>
          <SheetDescription>
            {isCreate ? t('form.createDescription') : t('form.editDescription')}
          </SheetDescription>
        </SheetHeader>
        <KeyForm {...formProps} />
      </SheetContent>
    </Sheet>
  );
}
