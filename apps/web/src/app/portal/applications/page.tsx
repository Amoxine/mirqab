'use client';

import { useState } from 'react';
import Link from 'next/link';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { AlertTriangle, Boxes, Plus } from 'lucide-react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { StateCard } from '@/components/shared/state-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { useCreatePortalApplication, usePortalApplications } from '@/hooks/use-portal';

function makeSchema(t: (key: string) => string) {
  return z.object({
    name: z.string().trim().min(2, t('errors.nameTooShort')).max(100, t('errors.nameTooLong')),
    description: z.string().trim().max(500, t('errors.descriptionTooLong')),
  });
}
type Values = z.infer<ReturnType<typeof makeSchema>>;

function CreateApplicationSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('portal');
  const tCommon = useTranslations('common');
  const createMutation = useCreatePortalApplication();
  const schema = makeSchema((key) => t(`applications.${key}`));
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: '', description: '' } });

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (values: Values) => {
    try {
      await createMutation.mutateAsync({ name: values.name, description: values.description || undefined });
      toast.success(t('applications.createdToast'));
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('applications.createError'));
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>{t('applications.createTitle')}</SheetTitle>
          <SheetDescription>{t('applications.createDescription')}</SheetDescription>
        </SheetHeader>
        <Form {...form}>
          <form
            onSubmit={(event) => {
              void form.handleSubmit(onSubmit)(event);
            }}
            className="flex flex-1 flex-col gap-4"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tCommon('name')}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={t('applications.namePlaceholder')} />
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
                  <FormLabel>{t('applications.descriptionLabel')}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <SheetFooter className="mt-auto gap-2 pt-2">
              <Button type="button" variant="outline" onClick={handleClose} disabled={form.formState.isSubmitting}>
                {tCommon('cancel')}
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? t('applications.creating') : tCommon('create')}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  );
}

export default function PortalApplicationsPage() {
  const t = useTranslations('portal');
  const tCommon = useTranslations('common');
  const [createOpen, setCreateOpen] = useState(false);
  const { data: applications, isLoading, isError, error, refetch } = usePortalApplications();

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('applications.title')}
        description={t('applications.subtitle')}
        actions={
          <Button
            type="button"
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('applications.createButton')}
          </Button>
        }
      />

      {isLoading && (
        <div className="space-y-3" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <StateCard role="alert" icon={<AlertTriangle className="text-destructive" aria-hidden="true" />} message={error.message}>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void refetch();
            }}
          >
            {tCommon('retry')}
          </Button>
        </StateCard>
      )}

      {!isLoading && !isError && applications?.length === 0 && (
        <StateCard icon={<Boxes aria-hidden="true" />} message={t('applications.empty')} />
      )}

      {!isLoading && !isError && applications && applications.length > 0 && (
        <div className="space-y-3">
          {applications.map((app) => (
            <Link key={app.id} href={`/portal/applications/${app.id}`} className="group block rounded-lg">
              <Card className="transition-colors duration-200 group-hover:border-primary/50">
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                  <CardTitle className="min-w-0 break-words text-base">{app.name}</CardTitle>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {t('applications.subscriptionCount', { count: app.subscriptionCount })}
                  </span>
                </CardHeader>
                {app.description && (
                  <CardContent className="pt-0 text-sm text-muted-foreground">{app.description}</CardContent>
                )}
              </Card>
            </Link>
          ))}
        </div>
      )}

      <CreateApplicationSheet open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
