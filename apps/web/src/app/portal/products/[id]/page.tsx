'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ArrowLeft, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { usePortalProduct } from '@/hooks/use-portal';
import { ApiDocsSection } from '@/components/portal/api-docs-section';
import { ApiRequestError } from '@/lib/portal-api-client';

/** Docs page (WP23): the product's own info, then one docs+try-it section per member API. */
export default function PortalProductPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('portal');
  const tCommon = useTranslations('common');
  const { data: product, isPending, isError, error, refetch } = usePortalProduct(id);

  if (isPending) {
    return (
      <div className="space-y-6" aria-busy="true">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (isError) {
    const notFound = error instanceof ApiRequestError && error.status === 404;
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          {notFound ? (
            <SearchX className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
          ) : (
            <AlertTriangle className="h-10 w-10 text-destructive" aria-hidden="true" />
          )}
          <p className="text-sm text-muted-foreground">{notFound ? t('docs.notFound') : error.message}</p>
          <div className="flex gap-2">
            {!notFound && (
              <Button
                type="button"
                onClick={() => {
                  void refetch();
                }}
              >
                {tCommon('retry')}
              </Button>
            )}
            <Button asChild variant="outline">
              <Link href="/portal">{t('docs.backToCatalog')}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ms-3">
          <Link href="/portal">
            <ArrowLeft className="me-2 h-4 w-4" />
            {t('docs.backToCatalog')}
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{product.name}</h1>
          {product.description && <p className="mt-1 text-muted-foreground">{product.description}</p>}
        </div>
      </div>

      {product.apis.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">{t('docs.noApis')}</CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {product.apis.map((api) => (
            <ApiDocsSection key={api.id} apiId={api.id} />
          ))}
        </div>
      )}
    </div>
  );
}
