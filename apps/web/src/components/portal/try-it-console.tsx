'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { AlertTriangle, Send } from 'lucide-react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { GATEWAY_URL } from '@/lib/gateway-url';
import type { PortalApiDoc } from '@/hooks/use-portal';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function makeSchema(t: (key: string) => string) {
  return z.object({
    method: z.enum(METHODS),
    path: z.string().trim().regex(/^\//, t('tryIt.pathMustStartWithSlash')),
    keyValue: z.string().trim().min(1, t('tryIt.keyRequired')),
    body: z.string(),
  });
}
type Values = z.infer<ReturnType<typeof makeSchema>>;

/**
 * The path clients call this API under: the sanitized document's own `servers[0].url`, which the
 * API sets to `/{tenantSlug}{listenPath}`. The developer's key goes to whatever this returns, so only
 * a plain path (relative to the gateway origin) is accepted from the document; anything else —
 * an absolute URL, a scheme-relative one, a non-string — falls back to the listen path the API
 * reported separately.
 */
function gatewayBasePath(api: PortalApiDoc): string {
  const servers = api.oasDocument?.servers;
  const first: unknown = Array.isArray(servers) ? servers[0] : undefined;
  const url = typeof first === 'object' && first !== null ? (first as { url?: unknown }).url : undefined;
  const base = typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : api.gatewayListenPath;
  return base.replace(/\/+$/, '');
}

interface TryResult {
  status: number;
  body: string;
}

/**
 * Calls the REAL gateway directly from the browser — never through the api, which would mean this
 * app's own credentials stood in for the developer's. The developer supplies their own key: it is
 * only ever shown to them once, at subscription creation, and never stored or re-fetched by this
 * app (`PortalSubscription.keyValue` is optional on the type for exactly that reason), so pasting it
 * here is the only way this console can ever have it.
 */
export function TryItConsole({ api }: { api: PortalApiDoc }) {
  const t = useTranslations('portal');
  const [result, setResult] = useState<TryResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const headerName = api.authHeaderName ?? 'Authorization';
  const schema = makeSchema(t);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { method: 'GET', path: '/', keyValue: '', body: '' },
  });
  const method = form.watch('method');

  const onSubmit = async (values: Values) => {
    setRequestError(null);
    setResult(null);
    const url = `${GATEWAY_URL}${gatewayBasePath(api)}/${values.path.replace(/^\//, '')}`;
    try {
      const res = await fetch(url, {
        method: values.method,
        headers: {
          [headerName]: values.keyValue,
          ...(values.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(values.body && values.method !== 'GET' ? { body: values.body } : {}),
      });
      setResult({ status: res.status, body: await res.text() });
    } catch {
      // A real network failure (CORS, DNS, the gateway unreachable) — the gateway's own error
      // responses (401/403/404/5xx) land in the try branch above as a normal result, not here.
      setRequestError(t('tryIt.networkError'));
    }
  };

  return (
    <Form {...form}>
      <form
        onSubmit={(event) => {
          void form.handleSubmit(onSubmit)(event);
        }}
        className="space-y-4 rounded-md border p-4"
      >
        <h4 className="text-sm font-semibold">{t('tryIt.title')}</h4>
        <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
          <FormField
            control={form.control}
            name="method"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('tryIt.method')}</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {METHODS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="path"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('tryIt.path')}</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="/users/42" className="font-mono text-sm" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="keyValue"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('tryIt.keyLabel', { header: headerName })}</FormLabel>
              <FormControl>
                <Input {...field} type="password" autoComplete="off" className="font-mono text-sm" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {method !== 'GET' && (
          <FormField
            control={form.control}
            name="body"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('tryIt.body')}</FormLabel>
                <FormControl>
                  <Textarea {...field} rows={3} className="font-mono text-xs" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {requestError && (
          <div role="alert" className="flex gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
            <p className="min-w-0 break-words">{requestError}</p>
          </div>
        )}
        {result && (
          <div className="space-y-2 rounded-md border p-3" role="status">
            <p className="text-sm font-medium">
              {t('tryIt.responseStatus')}
              {': '}
              <span className="font-mono">{result.status}</span>
            </p>
            <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">{result.body}</pre>
          </div>
        )}

        <Button type="submit" loading={form.formState.isSubmitting}>
          {!form.formState.isSubmitting && <Send className="h-4 w-4" aria-hidden="true" />}
          {form.formState.isSubmitting ? t('tryIt.sending') : t('tryIt.send')}
        </Button>
      </form>
    </Form>
  );
}
