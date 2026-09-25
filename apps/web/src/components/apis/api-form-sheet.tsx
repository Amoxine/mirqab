'use client';

import { useMemo } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm, type Control, type Resolver } from 'react-hook-form';
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
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/sonner';
import { useCreateApi, useUpdateApi, type ApiDefinition } from '@/hooks/use-apis';
import {
  AUTH_TYPES,
  makeApiFormSchema,
  toCreatePayload,
  toFormInput,
  toUpdatePayload,
  type ApiFormInput,
  type ApiFormValues,
} from './api-form-schema';
import { toastSyncOutcome } from '@/components/apis/sync-outcome-toast';


type TextFieldName =
  | 'name'
  | 'slug'
  | 'proxyUrl'
  | 'listenPath'
  | 'rateLimitRate'
  | 'rateLimitPer'
  | 'corsAllowedOrigins'
  | 'corsAllowedMethods'
  | 'corsAllowedHeaders'
  | 'corsExposedHeaders'
  | 'corsMaxAge';

type SwitchFieldName = 'corsEnable' | 'corsAllowCredentials' | 'doNotTrack';

interface TextFieldProps {
  control: Control<ApiFormInput>;
  name: TextFieldName;
  label: string;
  description?: string;
  placeholder?: string;
  disabled?: boolean;
  numeric?: boolean;
}

function TextField({ control, name, label, description, placeholder, disabled, numeric }: TextFieldProps) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input {...field} placeholder={placeholder} disabled={disabled} inputMode={numeric ? 'numeric' : undefined} />
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function SwitchField({
  control,
  name,
  label,
  description,
  disabled,
}: {
  control: Control<ApiFormInput>;
  name: SwitchFieldName;
  label: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="min-w-0 space-y-0.5">
              <FormLabel>{label}</FormLabel>
              <FormDescription>{description}</FormDescription>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} disabled={disabled} />
            </FormControl>
          </div>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

type ApiFormSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & ({ mode: 'create' } | { mode: 'edit'; api: ApiDefinition });

/** Create / edit sheet for an API. `mode="edit"` needs the `api` being edited. */
export function ApiFormSheet(props: ApiFormSheetProps) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">
        {/* Radix mounts the content only while open, so the form starts fresh (from the latest `api`) every time. */}
        <ApiFormBody {...props} />
      </SheetContent>
    </Sheet>
  );
}

function ApiFormBody(props: ApiFormSheetProps) {
  const { onOpenChange } = props;
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  const api = props.mode === 'edit' ? props.api : undefined;
  const createMutation = useCreateApi();
  const updateMutation = useUpdateApi(api?.id ?? '');

  const apiFormSchema = useMemo(() => makeApiFormSchema(t), [t]);
  const form = useForm<ApiFormInput, unknown, ApiFormValues>({
    // @hookform/resolvers 4.x types the resolver by the schema's OUTPUT only, but this schema transforms
    // (text -> numbers/arrays), so the form holds the INPUT shape: the cast restores the real types.
    resolver: zodResolver(apiFormSchema) as unknown as Resolver<ApiFormInput, unknown, ApiFormValues>,
    defaultValues: toFormInput(api),
  });
  // shadcn's FormField types `control` by the input shape only; the cast drops the (unused here) transformed-values generic.
  const control = form.control as unknown as Control<ApiFormInput>;
  const corsEnabled = form.watch('corsEnable');

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (values: ApiFormValues) => {
    try {
      if (api) {
        const saved = await updateMutation.mutateAsync(toUpdatePayload(values));
        toastSyncOutcome(t, saved, t('form.updatedToast'));
      } else {
        const saved = await createMutation.mutateAsync(toCreatePayload(values));
        toastSyncOutcome(t, saved, t('form.createdToast'));
      }
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('form.saveError'));
    }
  };

  const isSubmitting = form.formState.isSubmitting;

  return (
    <>
      <SheetHeader>
        <SheetTitle>{api ? t('form.editTitle') : t('form.createTitle')}</SheetTitle>
        <SheetDescription>
          {api ? t('form.editDescription') : t('form.createDescription')}
        </SheetDescription>
      </SheetHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <div className="space-y-4">
            <TextField control={control} name="name" label={tCommon('name')} />
            <TextField
              control={control}
              name="slug"
              label={t('field.slug')}
              placeholder={t('form.slugPlaceholder')}
              disabled={!!api}
              description={api ? t('form.slugLockedDescription') : undefined}
            />
            <FormField
              control={control}
              name="authType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('field.authType')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={t('form.authTypePlaceholder')} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {AUTH_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {t(`authTypes.${type}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <TextField control={control} name="proxyUrl" label={t('field.upstreamUrl')} placeholder={t('form.upstreamUrlPlaceholder')} />
            <TextField control={control} name="listenPath" label={t('field.listenPath')} placeholder={t('form.listenPathPlaceholder')} />
          </div>

          <div className="space-y-4">
            <h3 className="text-sm font-medium">{t('config.rateLimit')}</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                control={control}
                name="rateLimitRate"
                label={t('form.requestsLabel')}
                numeric
                description={t('form.rateLimitDescription')}
              />
              <TextField control={control} name="rateLimitPer" label={t('form.perSecondsLabel')} numeric />
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-sm font-medium">{t('config.cors')}</h3>
            <SwitchField
              control={control}
              name="corsEnable"
              label={t('form.enableCors')}
              description={t('form.enableCorsDescription')}
            />
            {/* Always rendered (disabled while CORS is off) so a bad value can never block submit unseen. */}
            <TextField
              control={control}
              name="corsAllowedOrigins"
              label={t('config.allowedOrigins')}
              placeholder={t('form.originsPlaceholder')}
              description={t('form.commaSeparated')}
              disabled={!corsEnabled}
            />
            <TextField
              control={control}
              name="corsAllowedMethods"
              label={t('config.allowedMethods')}
              placeholder={t('form.methodsPlaceholder')}
              description={t('form.commaSeparated')}
              disabled={!corsEnabled}
            />
            <TextField
              control={control}
              name="corsAllowedHeaders"
              label={t('config.allowedHeaders')}
              placeholder={t('form.headersPlaceholder')}
              description={t('form.commaSeparated')}
              disabled={!corsEnabled}
            />
            <TextField
              control={control}
              name="corsExposedHeaders"
              label={t('config.exposedHeaders')}
              placeholder={t('form.exposedHeadersPlaceholder')}
              description={t('form.commaSeparated')}
              disabled={!corsEnabled}
            />
            <SwitchField
              control={control}
              name="corsAllowCredentials"
              label={t('form.allowCredentials')}
              description={t('form.allowCredentialsDescription')}
              disabled={!corsEnabled}
            />
            <TextField control={control} name="corsMaxAge" label={t('form.maxAgeSecondsLabel')} numeric disabled={!corsEnabled} />
          </div>

          <div className="space-y-4">
            <h3 className="text-sm font-medium">{t('form.analyticsSection')}</h3>
            <SwitchField
              control={control}
              name="doNotTrack"
              label={t('config.doNotTrack')}
              description={t('form.doNotTrackDescription')}
            />
          </div>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={handleClose} disabled={isSubmitting}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {isSubmitting ? t('form.saving') : api ? t('form.saveChanges') : tCommon('create')}
            </Button>
          </div>
        </form>
      </Form>
    </>
  );
}
