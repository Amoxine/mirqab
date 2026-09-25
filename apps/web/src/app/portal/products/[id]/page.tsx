'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { StateCard } from '@/components/shared/state-card';
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
        <Skeleton className="h-9 w-64 max-w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (isError) {
    const notFound = error instanceof ApiRequestError && error.status === 404;
    return (
      <StateCard
        role={notFound ? undefined : 'alert'}
        icon={notFound ? <SearchX aria-hidden="true" /> : <AlertTriangle className="text-destructive" aria-hidden="true" />}
        message={notFound ? t('docs.notFound') : error.message}
      >
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
      </StateCard>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: '/portal', label: t('docs.backToCatalog') }}
        title={product.name}
        description={product.description}
      />

      {product.apis.length === 0 ? (
        <StateCard message={t('docs.noApis')} />
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
