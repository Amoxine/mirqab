'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm, type Control, type Resolver } from 'react-hook-form';
import { AlertTriangle, Send } from 'lucide-react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SheetFooter } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { useDebugApi, type ApiDefinition, type DebugResult } from '@/hooks/use-apis';
import { ApiRequestError } from '@/lib/api-client';
import { ConfigSheet } from './config-sheet';
import { pairLines } from './list-codec';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

type Translate = (key: string) => string;

function makeSchema(t: Translate) {
  return z.object({
    method: z.enum(METHODS),
    path: z.string().trim().regex(/^\//, t('designer.testRequest.pathMustStartWithSlash')),
    headers: pairLines(t('designer.headerTransform.addLineFormatError')),
    body: z.string(),
    targetUrl: z.string().trim(),
  });
}

type Input_ = z.input<ReturnType<typeof makeSchema>>;
type Values = z.infer<ReturnType<typeof makeSchema>>;

const emptyForm: Input_ = { method: 'GET', path: '/', headers: '', body: '', targetUrl: '' };

function ResultPanel({ result }: { result: DebugResult }) {
  const t = useTranslations('apis');
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">
        {t('designer.testRequest.responseCode')}
        {': '}
        <span className="font-mono">{result.response?.code ?? '—'}</span>
      </p>
      {result.response?.body !== undefined && (
        <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">{result.response.body}</pre>
      )}
    </div>
  );
}

interface TestRequestSheetProps {
  api: ApiDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * WP17: runs a sample request against the API's own stored definition (`POST /apis/:id/debug`). A
 * denied `targetUrl` override answers 400 — shown here as an inline error, same as any other failed
 * request, never a silent no-op.
 */
export function TestRequestSheet({ api, open, onOpenChange }: TestRequestSheetProps) {
  const t = useTranslations('apis');
  const debugMutation = useDebugApi(api.id);
  const [result, setResult] = useState<DebugResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const schema = makeSchema(t);
  const form = useForm<Input_, unknown, Values>({
    resolver: zodResolver(schema) as unknown as Resolver<Input_, unknown, Values>,
    defaultValues: emptyForm,
  });
  const control = form.control as unknown as Control<Input_>;

  const handleClose = () => {
    form.reset();
    setResult(null);
    setRequestError(null);
    onOpenChange(false);
  };

  const onSubmit = async (values: Values) => {
    setRequestError(null);
    setResult(null);
    try {
      const headers = Object.fromEntries(values.headers.map((h) => [h.name, h.value]));
      setResult(
        await debugMutation.mutateAsync({
          method: values.method,
          path: values.path,
          ...(Object.keys(headers).length ? { headers } : {}),
          ...(values.body ? { body: values.body } : {}),
          ...(values.targetUrl ? { targetUrl: values.targetUrl } : {}),
        }),
      );
    } catch (error) {
      // The SSRF-denied-host case (400) and any other failure both land here — a request that could
      // not be run is always shown, never dropped silently.
      setRequestError(
        error instanceof ApiRequestError || error instanceof Error
          ? error.message
          : t('designer.testRequest.error'),
      );
    }
  };

  return (
    <ConfigSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('designer.testRequest.title')}
      description={t('designer.testRequest.description')}
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <FormField
              control={control}
              name="method"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('designer.testRequest.method')}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {METHODS.map((method) => (
                        <SelectItem key={method} value={method}>
                          {method}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name="path"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('designer.testRequest.path')}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="/users/42" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <FormField
            control={control}
            name="headers"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.headerTransform.add')}</FormLabel>
                <FormControl>
                  <Textarea {...field} rows={2} placeholder="X-Trace: abc" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="body"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.testRequest.body')}</FormLabel>
                <FormControl>
                  <Textarea {...field} rows={3} className="font-mono text-xs" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="targetUrl"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('designer.testRequest.targetUrl')}</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="https://staging.orders.internal:4000" />
                </FormControl>
                <FormDescription>{t('designer.testRequest.targetUrlDescription')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {requestError && (
            <div role="alert" className="flex gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p className="min-w-0 break-words">{requestError}</p>
            </div>
          )}
          {result && <ResultPanel result={result} />}

          <SheetFooter className="mt-auto flex-col-reverse gap-2 pt-4 sm:flex-row sm:justify-end sm:gap-2">
            <Button type="button" variant="outline" onClick={handleClose} disabled={debugMutation.isPending}>
              {t('designer.testRequest.close')}
            </Button>
            <Button type="submit" disabled={debugMutation.isPending}>
              <Send className="me-2 h-4 w-4" />
              {debugMutation.isPending ? t('designer.testRequest.running') : t('designer.testRequest.run')}
            </Button>
          </SheetFooter>
        </form>
      </Form>
    </ConfigSheet>
  );
}
