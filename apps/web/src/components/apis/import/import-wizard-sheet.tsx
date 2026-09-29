'use client';

import { Notice } from '@open-gateway/ui';
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
import { toast } from '@/components/ui/sonner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { previewImport, useImportApi, type ImportOptions, type ImportPreview } from '@/lib/api/openapi';
import {
  DEFAULT_INTERVAL,
  knownSpecError,
  previewImportUrl,
  SPEC_INTERVALS,
  specUrlProblem,
  useImportUrl,
  type SpecInterval,
} from '@/lib/api/spec-source';
import { ApiErrorText, describeApiError, toastApiError } from '@/components/apis/endpoints/api-error';
import { FindingsList } from './findings-list';
import { SpecSourceField, specSourceSchema } from './spec-source-field';

type Translate = (key: string, values?: Record<string, string | number>) => string;

const INTERVAL_VALUES = SPEC_INTERVALS.map(String) as [string, ...string[]];

/** `t` = `openapi`, `tSpec` = `specSource`. Only the active source (document or URL) is validated. */
const makeSchema = (t: Translate, tSpec: Translate) =>
  z
    .object({
      mode: z.enum(['document', 'url']),
      source: z.string(),
      // OAS-08: the server fetches it; it is only ever sent in a JSON body.
      url: z.string(),
      watch: z.boolean(),
      intervalMinutes: z.enum(INTERVAL_VALUES),
      // Blank = the slug derived from info.title. Same shape rule as the create form (api-form-schema.ts).
      slug: z.string().trim().regex(/^([a-z0-9]+(-[a-z0-9]+)*)?$/, t('import.slugInvalid')).max(100, t('import.slugTooLong')),
      // '' until the user picks a server: then the API chooses (a document with no `servers` gets no index).
      serverIndex: z.string(),
    })
    .superRefine((v, ctx) => {
      if (v.mode === 'document') {
        for (const issue of specSourceSchema(t).safeParse(v.source).error?.issues ?? []) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: ['source'] });
        }
        return;
      }
      const problem = specUrlProblem(v.url);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: tSpec(problem), path: ['url'] });
    });
type Values = z.infer<ReturnType<typeof makeSchema>>;
const DEFAULTS: Values = {
  mode: 'document',
  source: '',
  url: '',
  watch: true,
  intervalMinutes: String(DEFAULT_INTERVAL),
  slug: '',
  serverIndex: '',
};

const optionsOf = (v: Values): ImportOptions => ({
  slug: v.slug.trim() || undefined,
  serverIndex: v.serverIndex === '' ? undefined : Number(v.serverIndex),
});
/** What a preview was computed for; the import runs only on a preview of exactly these values. */
type PreviewInputs = Pick<Values, 'mode' | 'source' | 'url' | 'slug' | 'serverIndex'>;
const sameInputs = (a: PreviewInputs, b: PreviewInputs) =>
  // String `===` fails fast on length or the first differing character: no 5 MB copy per keystroke.
  a.mode === b.mode &&
  (a.mode === 'url' ? a.url.trim() === b.url.trim() : a.source === b.source) &&
  a.slug.trim() === b.slug.trim() &&
  a.serverIndex === b.serverIndex;

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
  const tSpec = useTranslations('specSource');
  const importMutation = useImportApi();
  const importUrlMutation = useImportUrl();
  const schema = useMemo(() => makeSchema(t, tSpec), [t, tSpec]);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: DEFAULTS });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewed, setPreviewed] = useState<Values | null>(null);
  const [previewError, setPreviewError] = useState<{ message: string; detail?: string } | null>(null);

  const [mode, source, url, slug, serverIndex, watch] = useWatch({
    control: form.control,
    name: ['mode', 'source', 'url', 'slug', 'serverIndex', 'watch'],
  });
  const current = preview !== null && previewed !== null && sameInputs(previewed, { mode, source, url, slug, serverIndex });
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
        const result =
          v.mode === 'url'
            ? await importUrlMutation.mutateAsync({
                url: v.url.trim(),
                options: { ...optionsOf(v), watch: v.watch, intervalMinutes: Number(v.intervalMinutes) as SpecInterval },
              })
            : await importMutation.mutateAsync({ source: v.source, options: optionsOf(v) });
        toastSyncOutcome(tApis, result.api, t('import.createdToast', { name: result.api.name }));
        close();
        router.push(`/apis/${result.api.id}?tab=endpoints`);
      } catch (error) {
        // From a URL: translated text only, never the server's message (it could echo the URL).
        if (v.mode === 'url') toast.error(knownSpecError(tSpec, error) ?? describeApiError(t, error, 'import.error').message);
        else toastApiError(t, error, 'import.error');
      }
      return;
    }
    setPreviewError(null);
    try {
      const next = v.mode === 'url' ? await previewImportUrl(v.url.trim(), optionsOf(v)) : await previewImport(v.source, optionsOf(v));
      setPreview(next);
      setPreviewed(v);
      if (next.conflicts.slug || next.conflicts.listenPath) form.setFocus('slug');
    } catch (error) {
      setPreview(null);
      setPreviewError(
        v.mode === 'url'
          ? { message: knownSpecError(tSpec, error) ?? describeApiError(t, error, 'import.previewError').message }
          : describeApiError(t, error, 'import.previewError'),
      );
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
          <Tabs
            value={mode}
            onValueChange={(next) => {
              form.setValue('mode', next === 'url' ? 'url' : 'document');
              form.clearErrors();
              setPreview(null);
              setPreviewed(null);
              setPreviewError(null);
            }}
          >
            <TabsList aria-label={tSpec('import.tabsLabel')}>
              <TabsTrigger value="document" disabled={isSubmitting}>{tSpec('import.tabDocument')}</TabsTrigger>
              <TabsTrigger value="url" disabled={isSubmitting}>{tSpec('import.tabUrl')}</TabsTrigger>
            </TabsList>
            <TabsContent value="document" className="mt-4">
              <SpecSourceField
                control={form.control}
                name="source"
                disabled={isSubmitting}
                onFileError={(message) => {
                  form.setError('source', { message });
                }}
              />
            </TabsContent>
            <TabsContent value="url" className="mt-4 space-y-4">
              <FormField
                control={form.control}
                name="url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tSpec('sheet.urlLabel')}</FormLabel>
                    <FormControl>
                      {/* The URL may carry an access token: never offered to autofill, history or spell check. */}
                      <Input
                        {...field}
                        dir="ltr"
                        inputMode="url"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        placeholder="https://"
                        disabled={isSubmitting}
                      />
                    </FormControl>
                    <FormDescription>{tSpec('import.urlHelp')}</FormDescription>
                    <FormDescription>{tSpec('import.refetchNote')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="watch"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4 space-y-0">
                    <div className="min-w-0 space-y-0.5">
                      <FormLabel>{tSpec('import.watch')}</FormLabel>
                      <FormDescription>{tSpec('import.watchHelp')}</FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} disabled={isSubmitting} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {watch && (
                <FormField
                  control={form.control}
                  name="intervalMinutes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tSpec('sheet.intervalLabel')}</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange} disabled={isSubmitting}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {SPEC_INTERVALS.map((m) => (
                            <SelectItem key={m} value={String(m)}>
                              {tSpec(`intervals.${String(m)}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </TabsContent>
          </Tabs>

          {previewError && (
            <Notice tone="destructive" role="alert"><ApiErrorText {...previewError} /></Notice>
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
                <Notice>
                  <p>{t('import.conflict')}</p>
                </Notice>
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
