'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Upload } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { toast } from '@/components/ui/sonner';
import { useUploadCertificate } from '@/hooks/use-certificates';

function makeUploadSchema(t: (key: string) => string) {
  return z.object({
    pem: z
      .string()
      .trim()
      .min(1, t('form.errors.pemRequired'))
      .refine((v) => v.includes('BEGIN CERTIFICATE'), t('form.errors.pemInvalid')),
  });
}
type UploadFormValues = z.infer<ReturnType<typeof makeUploadSchema>>;

interface CertificateUploadSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Upload sheet (U19) — a file input reads the PEM as text client-side; nothing here ever sends the
 * file anywhere but straight to `POST /certificates`, and the response never carries it back. */
export function CertificateUploadSheet({ open, onOpenChange }: CertificateUploadSheetProps) {
  const t = useTranslations('certificates');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t('form.uploadTitle')}</SheetTitle>
          <SheetDescription>{t('form.uploadDescription')}</SheetDescription>
        </SheetHeader>
        {/* Radix mounts content only while open, so the form starts fresh every time. */}
        {open && <UploadForm onOpenChange={onOpenChange} />}
      </SheetContent>
    </Sheet>
  );
}

function UploadForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('certificates');
  const tCommon = useTranslations('common');
  const uploadMutation = useUploadCertificate();

  const schema = makeUploadSchema(t);
  const form = useForm<UploadFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { pem: '' },
  });

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    form.setValue('pem', text, { shouldValidate: true });
  };

  const onSubmit = async (values: UploadFormValues) => {
    try {
      await uploadMutation.mutateAsync(values.pem);
      toast.success(t('form.uploadSuccess'));
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('form.uploadFailed'));
    }
  };

  const isSubmitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
        <FormItem>
          <FormLabel>{t('form.fileLabel')}</FormLabel>
          <FormControl>
            <input
              type="file"
              accept=".pem,.crt,.cer,.key,text/plain"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm file:me-3 file:border-0 file:bg-transparent file:text-sm file:font-medium"
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
              }}
            />
          </FormControl>
          <FormDescription>{t('form.fileHint')}</FormDescription>
        </FormItem>
        <FormField
          control={form.control}
          name="pem"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('form.pemLabel')}</FormLabel>
              <FormControl>
                <Textarea {...field} rows={10} className="font-mono text-xs" placeholder={t('form.pemPlaceholder')} />
              </FormControl>
              <FormDescription>{t('form.pemHint')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <SheetFooter className="mt-auto gap-2 pt-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={handleClose} disabled={isSubmitting}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            <Upload className="me-2 h-4 w-4" />
            {isSubmitting ? t('form.submitUploading') : t('form.submitUpload')}
          </Button>
        </SheetFooter>
      </form>
    </Form>
  );
}
