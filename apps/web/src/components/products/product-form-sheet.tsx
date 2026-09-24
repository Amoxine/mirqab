'use client';

import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { useApis } from '@/hooks/use-apis';
import { useCreateProduct, useUpdateProduct, type Product } from '@/hooks/use-products';

function makeProductFormSchema(t: (key: string) => string) {
  return z.object({
    name: z.string().trim().min(2, t('form.errors.nameTooShort')).max(100, t('form.errors.nameTooLong')),
    slug: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, t('form.errors.slugInvalid')),
    description: z.string().max(500).optional().or(z.literal('')),
    apiIds: z.array(z.string()),
  });
}
type ProductFormValues = z.infer<ReturnType<typeof makeProductFormSchema>>;

const emptyValues: ProductFormValues = { name: '', slug: '', description: '', apiIds: [] };

const valuesFromProduct = (product: Product): ProductFormValues => ({
  name: product.name,
  slug: product.slug,
  description: product.description ?? '',
  apiIds: product.apis.map((a) => a.id),
});

type ProductFormSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & ({ mode: 'create' } | { mode: 'edit'; product: Product });

/** Create/edit sheet for a product — a control-plane bundle of APIs a developer browses (U10). It
 * creates no gateway object; access still comes from a key's own access rights. */
export function ProductFormSheet(props: ProductFormSheetProps) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <ProductFormBody {...props} />
      </SheetContent>
    </Sheet>
  );
}

function ProductFormBody(props: ProductFormSheetProps) {
  const t = useTranslations('products');
  const tCommon = useTranslations('common');
  const { onOpenChange } = props;
  const product = props.mode === 'edit' ? props.product : undefined;
  const createMutation = useCreateProduct();
  const updateMutation = useUpdateProduct(product?.id ?? '');
  // ponytail: one page of 100 APIs feeds the picker, same cap as the keys create form.
  const { data: apis, isLoading: apisLoading } = useApis(1, 100);
  const apiList = useMemo(() => apis?.data ?? [], [apis]);

  const schema = useMemo(() => makeProductFormSchema(t), [t]);
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(schema),
    defaultValues: product ? valuesFromProduct(product) : emptyValues,
  });

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (values: ProductFormValues) => {
    const payload = {
      name: values.name.trim(),
      slug: values.slug.trim(),
      description: (values.description ?? '').length > 0 ? values.description : undefined,
      apiIds: values.apiIds,
    };
    try {
      if (product) {
        await updateMutation.mutateAsync(payload);
        toast.success(t('form.updateSuccess'));
      } else {
        await createMutation.mutateAsync(payload);
        toast.success(t('form.createSuccess'));
      }
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(product ? 'form.updateFailed' : 'form.createFailed'));
    }
  };

  const isSubmitting = form.formState.isSubmitting;

  return (
    <>
      <SheetHeader>
        <SheetTitle>{product ? t('form.editTitle') : t('form.createTitle')}</SheetTitle>
        <SheetDescription>{product ? t('form.editDescription') : t('form.createDescription')}</SheetDescription>
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
            name="slug"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('fields.slug')}</FormLabel>
                <FormControl>
                  <Input {...field} placeholder={t('form.slugPlaceholder')} />
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
            name="apiIds"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('fields.apis')}</FormLabel>
                <FormDescription>{t('form.apisHint')}</FormDescription>
                <ScrollArea className="h-48 rounded-md border p-3">
                  {apisLoading ? (
                    <p className="text-sm text-muted-foreground">{t('form.apisLoading')}</p>
                  ) : apiList.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('form.noApis')}</p>
                  ) : (
                    <div className="space-y-2">
                      {apiList.map((api) => (
                        <label key={api.id} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={field.value.includes(api.id)}
                            onCheckedChange={(checked) => {
                              field.onChange(
                                checked ? [...field.value, api.id] : field.value.filter((id) => id !== api.id),
                              );
                            }}
                          />
                          {api.name}
                        </label>
                      ))}
                    </div>
                  )}
                </ScrollArea>
                <FormMessage />
              </FormItem>
            )}
          />
          <SheetFooter className="mt-auto gap-2 pt-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={handleClose} disabled={isSubmitting}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {product
                ? t(isSubmitting ? 'form.submitSaving' : 'form.submitSave')
                : t(isSubmitting ? 'form.submitCreating' : 'form.submitCreate')}
            </Button>
          </SheetFooter>
        </form>
      </Form>
    </>
  );
}
