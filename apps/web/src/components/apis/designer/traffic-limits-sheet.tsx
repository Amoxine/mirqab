'use client';

import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm, type Control, type Resolver } from 'react-hook-form';
import { z } from 'zod';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/sonner';
import { useUpdateApi, type ApiDefinition } from '@/hooks/use-apis';
import { fraction01, optionalWholeNumber, wholeNumber } from './list-codec';
import { ConfigSheet, ConfigSheetFooter } from './config-sheet';

// The edge's own Coraza body-size limit (infra/edge/Caddyfile, WP26b) — the same constant the
// backend DTO caps against (`api-config.dto.ts`'s EDGE_BODY_LIMIT_BYTES). Duplicated rather than
// imported: the two apps share no types package, and the backend's own validator is the real
// enforcement — this only gives the field a sane client-side max instead of a round trip to find out.
const EDGE_BODY_LIMIT_BYTES = 10_485_760;

type Translate = (key: string, values?: Record<string, string | number>) => string;

function makeSchema(t: Translate) {
  return z.object({
    rateLimitRate: wholeNumber(t('designer.errors.wholeNumberInvalid'), t('designer.errors.wholeNumberTooSmall', { min: 0 }), 0),
    rateLimitPer: wholeNumber(t('designer.errors.wholeNumberInvalid'), t('designer.errors.wholeNumberTooSmall', { min: 1 }), 1),
    throttleRetryLimit: wholeNumber(t('designer.errors.wholeNumberInvalid'), t('designer.errors.wholeNumberTooSmall', { min: 0 }), 0),
    throttleIntervalSeconds: wholeNumber(t('designer.errors.wholeNumberInvalid'), t('designer.errors.wholeNumberTooSmall', { min: 1 }), 1),
    timeoutSeconds: optionalWholeNumber(t('designer.errors.wholeNumberInvalid'), t('designer.errors.wholeNumberTooSmall', { min: 1 }), 1),
    requestSizeLimitBytes: optionalWholeNumber(
      t('designer.errors.wholeNumberInvalid'),
      t('designer.traffic.sizeLimitRangeError'),
      1,
      EDGE_BODY_LIMIT_BYTES,
    ),
    circuitBreakerEnabled: z.boolean(),
    circuitBreakerThreshold: fraction01(t('designer.traffic.thresholdError')),
    circuitBreakerSampleSize: wholeNumber(t('designer.errors.wholeNumberInvalid'), t('designer.errors.wholeNumberTooSmall', { min: 1 }), 1),
    circuitBreakerCoolDownSeconds: wholeNumber(t('designer.errors.wholeNumberInvalid'), t('designer.errors.wholeNumberTooSmall', { min: 1 }), 1),
  });
}

type Input_ = z.input<ReturnType<typeof makeSchema>>;
type Values = z.infer<ReturnType<typeof makeSchema>>;

function toFormInput(api: ApiDefinition): Input_ {
  const c = api.config ?? {};
  return {
    rateLimitRate: String(c.rateLimit?.rate ?? 0),
    rateLimitPer: String(c.rateLimit?.per ?? 60),
    throttleRetryLimit: String(c.throttle?.retryLimit ?? 0),
    throttleIntervalSeconds: String(c.throttle?.intervalSeconds ?? 10),
    timeoutSeconds: c.timeoutSeconds ? String(c.timeoutSeconds) : '',
    requestSizeLimitBytes: c.requestSizeLimitBytes ? String(c.requestSizeLimitBytes) : '',
    circuitBreakerEnabled: !!c.circuitBreaker,
    circuitBreakerThreshold: String(c.circuitBreaker?.threshold ?? 0.5),
    circuitBreakerSampleSize: String(c.circuitBreaker?.sampleSize ?? 100),
    circuitBreakerCoolDownSeconds: String(c.circuitBreaker?.coolDownSeconds ?? 60),
  };
}

interface TrafficLimitsSheetProps {
  api: ApiDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** WP15a: rate limit, throttle, upstream timeout, request size limit, circuit breaker — all
 * scalar/near-scalar fields, one Sheet so the tenant sees the API's whole traffic envelope at once. */
export function TrafficLimitsSheet({ api, open, onOpenChange }: TrafficLimitsSheetProps) {
  const t = useTranslations('apis');
  const updateMutation = useUpdateApi(api.id);
  const schema = useMemo(() => makeSchema(t), [t]);
  const form = useForm<Input_, unknown, Values>({
    // See api-form-schema.ts's ApiFormBody: @hookform/resolvers types the resolver from the schema's
    // OUTPUT only, but this schema transforms text -> numbers, so the form itself holds the INPUT shape.
    resolver: zodResolver(schema) as unknown as Resolver<Input_, unknown, Values>,
    defaultValues: toFormInput(api),
  });
  // shadcn's FormField types `control` by the input shape only; the cast drops the (unused here) transformed-values generic.
  const control = form.control as unknown as Control<Input_>;
  const circuitBreakerEnabled = form.watch('circuitBreakerEnabled');

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (values: Values) => {
    try {
      await updateMutation.mutateAsync({
        config: {
          rateLimit: { rate: values.rateLimitRate, per: values.rateLimitPer },
          throttle: { retryLimit: values.throttleRetryLimit, intervalSeconds: values.throttleIntervalSeconds },
          timeoutSeconds: values.timeoutSeconds,
          requestSizeLimitBytes: values.requestSizeLimitBytes,
          circuitBreaker: values.circuitBreakerEnabled
            ? {
                threshold: values.circuitBreakerThreshold,
                sampleSize: values.circuitBreakerSampleSize,
                coolDownSeconds: values.circuitBreakerCoolDownSeconds,
              }
            : null,
        },
      });
      toast.success(t('designer.savedToast'));
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('designer.saveError'));
    }
  };

  return (
    <ConfigSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('designer.traffic.title')}
      description={t('designer.traffic.description')}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-6">
          <div className="space-y-4">
            <h3 className="text-sm font-medium">{t('config.rateLimit')}</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={control}
                name="rateLimitRate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.requestsLabel')}</FormLabel>
                    <FormControl>
                      <Input {...field} inputMode="numeric" />
                    </FormControl>
                    <FormDescription>{t('form.rateLimitDescription')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name="rateLimitPer"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('form.perSecondsLabel')}</FormLabel>
                    <FormControl>
                      <Input {...field} inputMode="numeric" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-sm font-medium">{t('designer.traffic.throttle')}</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={control}
                name="throttleRetryLimit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('designer.traffic.retryLimit')}</FormLabel>
                    <FormControl>
                      <Input {...field} inputMode="numeric" />
                    </FormControl>
                    <FormDescription>{t('designer.traffic.retryLimitDescription')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name="throttleIntervalSeconds"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('designer.traffic.retryIntervalSeconds')}</FormLabel>
                    <FormControl>
                      <Input {...field} inputMode="numeric" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-sm font-medium">{t('designer.traffic.limits')}</h3>
            <FormField
              control={control}
              name="timeoutSeconds"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('designer.traffic.timeoutSeconds')}</FormLabel>
                  <FormControl>
                    <Input {...field} inputMode="numeric" placeholder={t('designer.traffic.noLimitPlaceholder')} />
                  </FormControl>
                  <FormDescription>{t('designer.traffic.timeoutDescription')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name="requestSizeLimitBytes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('designer.traffic.sizeLimitBytes')}</FormLabel>
                  <FormControl>
                    <Input {...field} inputMode="numeric" placeholder={t('designer.traffic.noLimitPlaceholder')} />
                  </FormControl>
                  <FormDescription>
                    {t('designer.traffic.sizeLimitDescription', { max: EDGE_BODY_LIMIT_BYTES })}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="space-y-4">
            <FormField
              control={control}
              name="circuitBreakerEnabled"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                    <div className="min-w-0 space-y-0.5">
                      <FormLabel>{t('designer.traffic.circuitBreaker')}</FormLabel>
                      <FormDescription>{t('designer.traffic.circuitBreakerDescription')}</FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField
                control={control}
                name="circuitBreakerThreshold"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('designer.traffic.threshold')}</FormLabel>
                    <FormControl>
                      <Input {...field} disabled={!circuitBreakerEnabled} placeholder="0.5" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name="circuitBreakerSampleSize"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('designer.traffic.sampleSize')}</FormLabel>
                    <FormControl>
                      <Input {...field} inputMode="numeric" disabled={!circuitBreakerEnabled} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name="circuitBreakerCoolDownSeconds"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('designer.traffic.coolDownSeconds')}</FormLabel>
                    <FormControl>
                      <Input {...field} inputMode="numeric" disabled={!circuitBreakerEnabled} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </div>

          <ConfigSheetFooter isSubmitting={form.formState.isSubmitting} onCancel={handleClose} />
        </form>
      </Form>
    </ConfigSheet>
  );
}
