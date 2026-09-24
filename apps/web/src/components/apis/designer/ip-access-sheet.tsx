'use client';

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
import { arrayToLines, linesToArray } from './list-codec';

const schema = z.object({ allow: linesToArray, block: linesToArray });
type Input_ = z.input<typeof schema>;
type Values = z.infer<typeof schema>;

function toFormInput(api: ApiDefinition): Input_ {
  const ip = api.config?.ipAccessControl;
  return { allow: arrayToLines(ip?.allow), block: arrayToLines(ip?.block) };
}

interface IpAccessSheetProps {
  api: ApiDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * WP15c: IP allow/deny, evaluated against the CLIENT ip. Only meaningful because the edge REPLACES
 * `X-Forwarded-For` with the real peer rather than appending to it — a forged header naming an
 * allowed IP still gets the true denied peer's address here.
 */
export function IpAccessSheet({ api, open, onOpenChange }: IpAccessSheetProps) {
  const t = useTranslations('apis');
  const updateMutation = useUpdateApi(api.id);
  const form = useForm<Input_, unknown, Values>({
    resolver: zodResolver(schema) as unknown as Resolver<Input_, unknown, Values>,
    defaultValues: toFormInput(api),
  });
  const control = form.control as unknown as Control<Input_>;

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const save = async (ipAccessControl: ApiConfig['ipAccessControl']) => {
    try {
      await updateMutation.mutateAsync({ config: { ipAccessControl } });
      toast.success(t('designer.savedToast'));
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('designer.saveError'));
    }
  };

  const onSubmit = (values: Values) =>
    save(
      values.allow.length === 0 && values.block.length === 0
        ? null
        : { ...(values.allow.length ? { allow: values.allow } : {}), ...(values.block.length ? { block: values.block } : {}) },
    );

  return (
    <ConfigSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('designer.ipAccess.title')}
      description={t('designer.ipAccess.description')}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
          <FormField
            control={control}
            name="allow"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.ipAccess.allow')}</FormLabel>
                <FormControl>
                  <Textarea {...field} rows={4} placeholder="10.0.0.0/8" />
                </FormControl>
                <FormDescription>{t('designer.ipAccess.oneLinePerEntry')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="block"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.ipAccess.block')}</FormLabel>
                <FormControl>
                  <Textarea {...field} rows={4} placeholder="203.0.113.7" />
                </FormControl>
                <FormDescription>{t('designer.ipAccess.oneLinePerEntry')}</FormDescription>
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
