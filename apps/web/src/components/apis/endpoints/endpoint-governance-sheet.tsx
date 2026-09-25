'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm, type Control, type FieldPath } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toastSyncOutcome } from '@/components/apis/sync-outcome-toast';
import {
  appliesTo,
  isOffered,
  isStale,
  useUpdateEndpoints,
  type EndpointGovernanceList,
  type GovernanceControl,
  type GovernedEndpoint,
} from '@/lib/api/openapi';
import { toastApiError } from './api-error';
import { MethodBadge, WarningNotice } from './method-badge';
import { UnavailableControls } from './unavailable-controls';
import { makeGovernanceSchema, toFormValues, toPatch, type GovernanceFormValues } from './governance-form';

type Name = FieldPath<GovernanceFormValues>;

function TextField({
  control,
  name,
  label,
  description,
  numeric,
  multiline,
  disabled,
}: {
  control: Control<GovernanceFormValues>;
  name: Name;
  label: string;
  description?: string;
  numeric?: boolean;
  multiline?: boolean;
  disabled?: boolean;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            {multiline ? (
              <Textarea {...field} value={String(field.value)} dir="ltr" className="font-mono text-xs" rows={6} disabled={disabled} />
            ) : (
              <Input {...field} value={String(field.value)} inputMode={numeric ? 'numeric' : undefined} disabled={disabled} />
            )}
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** One governance control: a switch, and its fields only while it is on (progressive disclosure). */
function ControlSection({
  control,
  name,
  label,
  description,
  disabled,
  unavailableReason,
  children,
  on,
  removeOnly,
}: {
  control: Control<GovernanceFormValues>;
  name: Name;
  label: string;
  description: ReactNode;
  disabled: boolean;
  unavailableReason?: string;
  on: boolean;
  /** Shown when the control is stored but no longer offered: it can only be removed. */
  removeOnly?: string;
  children?: ReactNode;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className="space-y-3 rounded-md border p-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-0.5">
              <FormLabel>{label}</FormLabel>
              <FormDescription>{unavailableReason ?? description}</FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={Boolean(field.value)}
                onCheckedChange={field.onChange}
                // Not offered: it can still be switched OFF when it is stored, never on.
                disabled={disabled || (!!unavailableReason && !field.value)}
              />
            </FormControl>
          </div>
          {on && unavailableReason && <p className="text-sm text-muted-foreground">{removeOnly}</p>}
          {on && !unavailableReason && children && <div className="space-y-3">{children}</div>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

interface EndpointGovernanceSheetProps {
  apiId: string;
  endpoint: GovernedEndpoint | null;
  list: EndpointGovernanceList;
  /** The API has an API-wide cache: per-endpoint cache is refused by the API while it does. */
  apiWideCache: boolean;
  readOnly: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EndpointGovernanceSheet(props: EndpointGovernanceSheetProps) {
  return (
    <Sheet open={props.endpoint !== null} onOpenChange={props.onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">
        {props.endpoint && <GovernanceBody {...props} endpoint={props.endpoint} />}
      </SheetContent>
    </Sheet>
  );
}

function GovernanceBody({
  apiId,
  endpoint,
  list,
  apiWideCache,
  readOnly,
  onOpenChange,
}: EndpointGovernanceSheetProps & { endpoint: GovernedEndpoint }) {
  const t = useTranslations('openapi');
  const tApis = useTranslations('apis');
  const tCommon = useTranslations('common');
  const mutation = useUpdateEndpoints(apiId);
  const schema = useMemo(() => makeGovernanceSchema(t), [t]);
  const form = useForm<GovernanceFormValues>({
    resolver: zodResolver(schema),
    defaultValues: toFormValues(endpoint.governance),
  });
  const { control } = form;
  const values = form.watch();
  // Frozen with the form values: a save must compare-and-set against the state this form was
  // filled from. The live list may have moved on (another user); then the API answers 409.
  const [revision] = useState(list.revision);

  /** Why this endpoint cannot carry `control`, or undefined when it can. */
  const reason = (c: GovernanceControl): string | undefined => {
    if (!isOffered(list.capabilities, c)) return t('governance.notProven');
    if (!appliesTo(c, endpoint.method)) return t(`governance.methodOnly.${c}`);
    if (c === 'cache' && apiWideCache) return t('governance.cacheApiWide');
    return undefined;
  };
  const offered = (c: GovernanceControl) => reason(c) === undefined;

  const close = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (v: GovernanceFormValues) => {
    const { set, clear } = toPatch(v, endpoint.governance, offered);
    if (Object.keys(set).length === 0 && clear.length === 0) {
      close();
      return;
    }
    try {
      const saved = await mutation.mutateAsync({
        expectedRevision: revision,
        keys: [endpoint.key],
        ...(Object.keys(set).length ? { set } : {}),
        ...(clear.length ? { clear } : {}),
      });
      toastSyncOutcome(tApis, saved, t('governance.savedToast'));
      close();
    } catch (error) {
      toastApiError(t, error, 'governance.saveError');
      // Stale: the list refetches (useUpdateEndpoints.onError); close so the next edit starts from it.
      if (isStale(error)) close();
    }
  };

  const isSubmitting = form.formState.isSubmitting;
  const disabled = readOnly || isSubmitting;

  return (
    <>
      <SheetHeader>
        <SheetTitle>{readOnly ? t('governance.viewTitle') : t('governance.title')}</SheetTitle>
        <SheetDescription asChild>
          <div className="flex flex-wrap items-center gap-2">
            <MethodBadge method={endpoint.method} />
            <span dir="ltr" className="break-all font-mono text-xs">
              {endpoint.path}
            </span>
          </div>
        </SheetDescription>
        {endpoint.summary && <p className="text-sm text-muted-foreground">{endpoint.summary}</p>}
      </SheetHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {readOnly && (
            <p role="status" className="rounded-md bg-muted p-3 text-sm">
              {t('readOnly')}
            </p>
          )}
          <h3 className="text-sm font-medium">{t('governance.access')}</h3>
          <ControlSection
            control={control}
            name="enabled"
            label={t('governance.enabled')}
            description={t('governance.enabledHelp')}
            disabled={disabled}
            removeOnly={t('governance.removeOnly')}
            unavailableReason={reason('enabled')}
            on={values.enabled}
          />
          <ControlSection
            control={control}
            name="isPublic"
            label={t('governance.public')}
            description={t('governance.publicHelp')}
            disabled={disabled}
            removeOnly={t('governance.removeOnly')}
            unavailableReason={reason('auth')}
            on={values.isPublic}
          />

          <h3 className="text-sm font-medium">{t('governance.traffic')}</h3>
          <ControlSection
            control={control}
            name="rateLimitOn"
            label={t('governance.rateLimit')}
            description={t('governance.rateLimitHelp')}
            disabled={disabled}
            removeOnly={t('governance.removeOnly')}
            unavailableReason={reason('rateLimit')}
            on={values.rateLimitOn}
          >
            <WarningNotice>{t('governance.rateLimitShared')}</WarningNotice>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField control={control} name="rate" label={t('governance.rate')} numeric disabled={disabled} />
              <TextField control={control} name="per" label={t('governance.perSeconds')} numeric disabled={disabled} />
            </div>
          </ControlSection>
          <ControlSection
            control={control}
            name="timeoutOn"
            label={t('governance.timeout')}
            description={t('governance.timeoutHelp')}
            disabled={disabled}
            removeOnly={t('governance.removeOnly')}
            unavailableReason={reason('timeoutSeconds')}
            on={values.timeoutOn}
          >
            <TextField control={control} name="timeoutSeconds" label={t('governance.seconds')} numeric disabled={disabled} />
          </ControlSection>
          <ControlSection
            control={control}
            name="sizeOn"
            label={t('governance.sizeLimit')}
            description={t('governance.sizeLimitHelp')}
            disabled={disabled}
            removeOnly={t('governance.removeOnly')}
            unavailableReason={reason('requestSizeLimitBytes')}
            on={values.sizeOn}
          >
            <TextField control={control} name="sizeBytes" label={t('governance.bytes')} numeric disabled={disabled} />
          </ControlSection>

          <h3 className="text-sm font-medium">{t('governance.responses')}</h3>
          <ControlSection
            control={control}
            name="cacheOn"
            label={t('governance.cache')}
            description={t('governance.cacheHelp')}
            disabled={disabled}
            removeOnly={t('governance.removeOnly')}
            unavailableReason={reason('cache')}
            on={values.cacheOn}
          >
            <TextField control={control} name="cacheTimeout" label={t('governance.seconds')} numeric disabled={disabled} />
            <TextField
              control={control}
              name="cacheCodes"
              label={t('governance.cacheCodes')}
              description={t('governance.commaSeparated')}
              disabled={disabled}
            />
          </ControlSection>
          <ControlSection
            control={control}
            name="mockOn"
            label={t('governance.mock')}
            description={t('governance.mockHelp')}
            disabled={disabled}
            removeOnly={t('governance.removeOnly')}
            unavailableReason={reason('mock')}
            on={values.mockOn}
          >
            <TextField control={control} name="mockCode" label={t('governance.statusCode')} numeric disabled={disabled} />
            <TextField control={control} name="mockBody" label={t('governance.body')} multiline disabled={disabled} />
            <TextField
              control={control}
              name="mockHeaders"
              label={t('governance.headers')}
              description={t('governance.headersHelp')}
              multiline
              disabled={disabled}
            />
          </ControlSection>
          <ControlSection
            control={control}
            name="validateOn"
            label={t('governance.validate')}
            description={t('governance.validateHelp')}
            disabled={disabled}
            removeOnly={t('governance.removeOnly')}
            unavailableReason={reason('validateRequestSchema')}
            on={values.validateOn}
          >
            <TextField
              control={control}
              name="schema"
              label={t('governance.schema')}
              description={t('governance.schemaHelp')}
              multiline
              disabled={disabled}
            />
          </ControlSection>

          <UnavailableControls capabilities={list.capabilities} />

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={close} disabled={isSubmitting}>
              {readOnly ? tCommon('close') : tCommon('cancel')}
            </Button>
            {!readOnly && (
              <Button type="submit" loading={isSubmitting}>
                {tCommon('save')}
              </Button>
            )}
          </div>
        </form>
      </Form>
    </>
  );
}
