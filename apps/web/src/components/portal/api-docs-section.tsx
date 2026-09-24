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

/** Flattens `oasDocument.paths` (path -> method -> operation) into one row per path+method — same
 * resolution as WP17's dashboard endpoint list (the generated doc, not an imported spec's shape),
 * reimplemented locally rather than importing that dashboard component: different props, different
 * i18n namespace, and a ~10-line function is not worth a cross-domain import for. */
function toRows(oasDocument: Record<string, unknown> | null): EndpointRow[] {
  const paths = (oasDocument?.paths as Record<string, Record<string, unknown>> | undefined) ?? {};
  return Object.entries(paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => ({ path, method: method.toUpperCase() })),
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
        <CardContent className="flex items-center gap-2 py-6 text-sm text-destructive">
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
                <Badge variant="outline">{row.method}</Badge>
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
