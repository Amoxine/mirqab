'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { toastSyncOutcome } from '@/components/apis/sync-outcome-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { previewImport, useImportApi, type ImportOptions, type ImportPreview } from '@/lib/api/openapi';
import { ApiErrorText, describeApiError, toastApiError } from '@/components/apis/endpoints/api-error';
import { WarningNotice } from '@/components/apis/endpoints/method-badge';
import { FindingsList } from './findings-list';
import { SpecSourceField, specSourceSchema } from './spec-source-field';

type Translate = (key: string, values?: Record<string, string | number>) => string;

const makeSchema = (t: Translate) =>
  z.object({
    source: specSourceSchema(t),
    // Blank = the slug derived from info.title. Same shape rule as the create form (api-form-schema.ts).
    slug: z.string().trim().regex(/^([a-z0-9]+(-[a-z0-9]+)*)?$/, t('import.slugInvalid')).max(100, t('import.slugTooLong')),
    // '' until the user picks a server: then the API chooses (a document with no `servers` gets no index).
    serverIndex: z.string(),
  });
type Values = z.infer<ReturnType<typeof makeSchema>>;
const DEFAULTS: Values = { source: '', slug: '', serverIndex: '' };

const optionsOf = (v: Values): ImportOptions => ({
  slug: v.slug.trim() || undefined,
  serverIndex: v.serverIndex === '' ? undefined : Number(v.serverIndex),
});
/** What a preview was computed for; the import runs only on a preview of exactly these values. */
const sameInputs = (a: Values, b: Values) =>
  // String `===` fails fast on length or the first differing character: no 5 MB copy per keystroke.
  a.source === b.source && a.slug.trim() === b.slug.trim() && a.serverIndex === b.serverIndex;

/** Endpoint count per tag; untagged endpoints under their own bucket. */
function countByTag(preview: ImportPreview, untagged: string): [string, number][] {
  const counts = new Map<string, number>();
  for (const e of preview.endpoints) {
    for (const tag of e.tags.length ? e.tags : [untagged]) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

interface ImportWizardSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * OAS-05 import: paste or upload -> check (the API's own preview: findings, derived API, servers,
 * conflicts) -> import, then land on the new API's Endpoints tab. Three steps, one form.
 */
export function ImportWizardSheet({ open, onOpenChange }: ImportWizardSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">{open && <WizardBody onOpenChange={onOpenChange} />}</SheetContent>
    </Sheet>
  );
}

function WizardBody({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('openapi');
  const tApis = useTranslations('apis');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const importMutation = useImportApi();
  const schema = useMemo(() => makeSchema(t), [t]);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: DEFAULTS });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewed, setPreviewed] = useState<Values | null>(null);
  const [previewError, setPreviewError] = useState<{ message: string; detail?: string } | null>(null);

  const [source, slug, serverIndex] = useWatch({ control: form.control, name: ['source', 'slug', 'serverIndex'] });
  const current = preview !== null && previewed !== null && sameInputs(previewed, { source, slug, serverIndex });
  const readyToImport = current && preview.canImport;

  const close = () => {
    form.reset(DEFAULTS);
    setPreview(null);
    setPreviewed(null);
    setPreviewError(null);
    onOpenChange(false);
  };

  const onSubmit = async (v: Values) => {
    if (readyToImport) {
      try {
        const result = await importMutation.mutateAsync({ source: v.source, options: optionsOf(v) });
        toastSyncOutcome(tApis, result.api, t('import.createdToast', { name: result.api.name }));
        close();
        router.push(`/apis/${result.api.id}?tab=endpoints`);
      } catch (error) {
        toastApiError(t, error, 'import.error');
      }
      return;
    }
    setPreviewError(null);
    try {
      const next = await previewImport(v.source, optionsOf(v));
      setPreview(next);
      setPreviewed(v);
      if (next.conflicts.slug || next.conflicts.listenPath) form.setFocus('slug');
    } catch (error) {
      setPreview(null);
      setPreviewError(describeApiError(t, error, 'import.previewError'));
    }
  };

  const isSubmitting = form.formState.isSubmitting;
  const problems = preview ? Object.entries(preview.problems) : [];

  return (
    <>
      <SheetHeader>
        <SheetTitle>{t('import.title')}</SheetTitle>
        <SheetDescription>{t('import.description')}</SheetDescription>
      </SheetHeader>
      <ol className="flex flex-wrap gap-2 text-xs text-muted-foreground" aria-label={t('import.stepsLabel')}>
        {(['stepSource', 'stepCheck', 'stepImport'] as const).map((step, i) => {
          const active = i === (readyToImport ? 2 : preview ? 1 : 0);
          return (
            <li key={step} aria-current={active ? 'step' : undefined} className={active ? 'font-semibold text-foreground' : undefined}>
              {t(`import.${step}`, { n: i + 1 })}
            </li>
          );
        })}
      </ol>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
          <SpecSourceField
            control={form.control}
            name="source"
            disabled={isSubmitting}
            onFileError={(message) => {
              form.setError('source', { message });
            }}
          />

          {previewError && (
            <div role="alert" className="flex gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
              <ApiErrorText {...previewError} />
            </div>
          )}

          {preview && (
            <section aria-labelledby="import-review" className="space-y-4">
              <h3 id="import-review" className="flex items-center gap-2 text-sm font-medium">
                {preview.canImport ? (
                  <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
                )}
                {preview.canImport ? t('import.canImport') : t('import.cannotImport')}
              </h3>
              {!current && <p className="text-sm text-muted-foreground">{t('import.recheck')}</p>}

              <FindingsList findings={preview.findings} />

              {problems.length > 0 && (
                <ul role="alert" className="space-y-1 text-sm text-destructive">
                  {problems.flatMap(([key, messages]) =>
                    messages.map((m) => (
                      <li key={`${key}-${m}`} dir="ltr" className="break-words">
                        {m}
                      </li>
                    )),
                  )}
                </ul>
              )}

              <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{tCommon('name')}</dt>
                <dd className="break-words">{preview.derived.name}</dd>
                <dt className="text-muted-foreground">{tApis('field.slug')}</dt>
                <dd dir="ltr" className="break-all font-mono text-xs">{preview.derived.slug}</dd>
                <dt className="text-muted-foreground">{tApis('field.listenPath')}</dt>
                <dd dir="ltr" className="break-all font-mono text-xs">{preview.derived.listenPath}</dd>
                <dt className="text-muted-foreground">{tApis('field.upstreamUrl')}</dt>
                <dd dir="ltr" className="break-all font-mono text-xs">{preview.derived.proxyUrl || '—'}</dd>
                <dt className="text-muted-foreground">{t('import.openapiVersion')}</dt>
                <dd dir="ltr">{preview.openapiVersion}</dd>
              </dl>

              {(preview.conflicts.slug || preview.conflicts.listenPath) && (
                <WarningNotice>
                  <p>{t('import.conflict')}</p>
                </WarningNotice>
              )}

              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('import.slugOverride')}</FormLabel>
                    <FormControl>
                      <Input {...field} dir="ltr" placeholder={preview.derived.slug} disabled={isSubmitting} />
                    </FormControl>
                    <FormDescription>{t('import.slugOverrideHelp')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {preview.servers.length > 0 && (
                <FormField
                  control={form.control}
                  name="serverIndex"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('import.upstream')}</FormLabel>
                      <Select
                        value={field.value || String(preview.servers.find((s) => s.selected)?.index ?? '')}
                        onValueChange={field.onChange}
                        disabled={isSubmitting}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {preview.servers.map((s) => (
                            <SelectItem key={s.index} value={String(s.index)} disabled={!s.url || !!s.denyReason}>
                              <span dir="ltr" className="font-mono text-xs">{s.url ?? t('import.serverNoDefault')}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                      {preview.servers.some((s) => s.denyReason !== null || !s.url) && (
                        <ul className="space-y-1 text-sm text-muted-foreground">
                          {preview.servers
                            .filter((s) => s.denyReason !== null || !s.url)
                            .map((s) => (
                              <li key={s.index} className="break-words">
                                {t('import.serverRefused', { index: s.index + 1 })}{' '}
                                <span dir="ltr">{s.denyReason ?? t('import.serverNoDefault')}</span>
                              </li>
                            ))}
                        </ul>
                      )}
                    </FormItem>
                  )}
                />
              )}

              <div className="space-y-2">
                <p className="text-sm font-medium">{t('import.endpoints', { count: preview.endpointCount })}</p>
                <div className="flex flex-wrap gap-1">
                  {countByTag(preview, t('import.untagged')).map(([tag, n]) => (
                    <Badge key={tag} variant="outline" className="font-normal">
                      {t('import.tagCount', { tag, count: n })}
                    </Badge>
                  ))}
                </div>
              </div>
            </section>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={close} disabled={isSubmitting}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" loading={isSubmitting} disabled={current && !preview.canImport}>
              {readyToImport ? t('import.import') : t('import.check')}
            </Button>
          </div>
        </form>
      </Form>
    </>
  );
}
