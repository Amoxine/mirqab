'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { usePortalApiDoc } from '@/hooks/use-portal';
import { TryItConsole } from './try-it-console';

interface EndpointRow {
  path: string;
  method: string;
}

/** The keys of an OpenAPI path item that are operations; the rest (`parameters`, `summary`, `servers`, `$ref`, `x-…`) are not. */
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Flattens `oasDocument.paths` (path -> method -> operation) into one row per path+method. The
 * document is the sanitized copy of the API's stored specification (OAS-06), so a path item holds
 * more than operations, and the shape is never assumed: anything that is not an object is skipped.
 * Reimplemented locally rather than importing the dashboard's endpoint list: different props,
 * different i18n namespace, and a few lines are not worth a cross-domain import. */
function toRows(oasDocument: Record<string, unknown> | null): EndpointRow[] {
  const paths = oasDocument?.paths;
  if (!isRecord(paths)) return [];
  return Object.entries(paths).flatMap(([path, item]) =>
    isRecord(item)
      ? Object.keys(item)
          .filter((method) => HTTP_METHODS.has(method))
          .map((method) => ({ path, method: method.toUpperCase() }))
      : [],
  );
}

export function ApiDocsSection({ apiId }: { apiId: string }) {
  const t = useTranslations('portal');
  const { data: api, isLoading, isError, error } = usePortalApiDoc(apiId);

  if (isLoading) {
    return (
      <Card aria-busy="true">
        <CardHeader>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !api) {
    return (
      <Card>
        <CardContent role="alert" className="flex items-center gap-2 py-6 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{error?.message ?? t('docs.loadError')}</p>
        </CardContent>
      </Card>
    );
  }

  const rows = toRows(api.oasDocument);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{api.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('docs.noEndpoints')}</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((row) => (
              <li key={`${row.method}-${row.path}`} className="flex items-center gap-2 text-sm">
                <Badge variant="outline" className="min-w-16 justify-center font-mono">
                  {row.method}
                </Badge>
                <span className="break-all font-mono text-xs">{row.path}</span>
              </li>
            ))}
          </ul>
        )}
        <TryItConsole api={api} />
      </CardContent>
    </Card>
  );
}
