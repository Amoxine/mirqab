'use client';

import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { toast } from '@/components/ui/sonner';
import {
  useCreatePortalSubscription,
  usePortalPlans,
  usePortalProducts,
  type PortalSubscription,
} from '@/hooks/use-portal';

const schema = z.object({ productId: z.string().min(1), planId: z.string().min(1) });
type Values = z.infer<typeof schema>;

interface SubscribeSheetProps {
  applicationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The key is only ever in the response of THIS call — the caller shows it once, right here. */
  onSubscribed: (subscription: PortalSubscription) => void;
}

export function SubscribeSheet({ applicationId, open, onOpenChange, onSubscribed }: SubscribeSheetProps) {
  const t = useTranslations('portal');
  const tCommon = useTranslations('common');
  const { data: products } = usePortalProducts();
  const { data: plans } = usePortalPlans();
  const createMutation = useCreatePortalSubscription(applicationId);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { productId: '', planId: '' } });
  const hasChoices = useMemo(() => !!products?.length && !!plans?.length, [products, plans]);

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (values: Values) => {
    try {
      const subscription = await createMutation.mutateAsync(values);
      // Only an APPROVED subscription is reported as a success; PENDING is information, not done.
      if (subscription.status === 'PENDING') toast.info(t('subscribe.pendingToast'));
      else toast.success(t('subscribe.approvedToast'));
      onSubscribed(subscription);
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('subscribe.error'));
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>{t('subscribe.title')}</SheetTitle>
          <SheetDescription>{t('subscribe.description')}</SheetDescription>
        </SheetHeader>
        {!hasChoices ? (
          <p className="text-sm text-muted-foreground">{t('subscribe.noChoices')}</p>
        ) : (
          <Form {...form}>
            <form
              onSubmit={(event) => {
                void form.handleSubmit(onSubmit)(event);
              }}
              className="flex flex-1 flex-col gap-4"
            >
              <FormField
                control={form.control}
                name="productId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('subscribe.product')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('subscribe.productPlaceholder')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {products?.map((product) => (
                          <SelectItem key={product.id} value={product.id}>
                            {product.name}
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
                name="planId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('subscribe.plan')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t('subscribe.planPlaceholder')} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {plans?.map((plan) => (
                          <SelectItem key={plan.id} value={plan.id}>
                            {plan.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <SheetFooter className="mt-auto gap-2 pt-2">
                <Button type="button" variant="outline" onClick={handleClose} disabled={form.formState.isSubmitting}>
                  {tCommon('cancel')}
                </Button>
                <Button type="submit" loading={form.formState.isSubmitting}>
                  {form.formState.isSubmitting ? t('subscribe.subscribing') : t('subscribe.submit')}
                </Button>
              </SheetFooter>
            </form>
          </Form>
        )}
      </SheetContent>
    </Sheet>
  );
}
