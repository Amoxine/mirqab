'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel } from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/sonner';
import { useUpdateApi, type ApiDefinition } from '@/hooks/use-apis';
import { ConfigSheet, ConfigSheetFooter } from './config-sheet';
import { toastSyncOutcome } from '@/components/apis/sync-outcome-toast';

const schema = z.object({ detailedRecording: z.boolean() });
type Values = z.infer<typeof schema>;

interface DetailedRecordingSheetProps {
  api: ApiDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** WP15b (O9): per-API full request/response recording. Global default stays off — this is the one
 * field on this Sheet, but it gets the same Sheet treatment as every other Designer section. */
export function DetailedRecordingSheet({ api, open, onOpenChange }: DetailedRecordingSheetProps) {
  const t = useTranslations('apis');
  const updateMutation = useUpdateApi(api.id);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { detailedRecording: api.config?.detailedRecording ?? false },
  });

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (values: Values) => {
    try {
      const saved = await updateMutation.mutateAsync({ config: { detailedRecording: values.detailedRecording } });
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
      title={t('designer.detailedRecording.title')}
      description={t('designer.detailedRecording.description')}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
          <FormField
            control={form.control}
            name="detailedRecording"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div className="min-w-0 space-y-0.5">
                    <FormLabel>{t('designer.detailedRecording.enable')}</FormLabel>
                    <FormDescription>{t('designer.detailedRecording.enableDescription')}</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </div>
              </FormItem>
            )}
          />
          {/* V1-LOG-02: this toggle used to be a dead end — nothing read the capture back. */}
          <p className="text-sm text-muted-foreground">{t('designer.detailedRecording.viewHint')}</p>
          <ConfigSheetFooter isSubmitting={form.formState.isSubmitting} onCancel={handleClose} />
        </form>
      </Form>
    </ConfigSheet>
  );
}
