'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ChevronRight, Package } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/page-header';
import { StateCard } from '@/components/shared/state-card';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { usePortalProducts } from '@/hooks/use-portal';

/**
 * The catalog (WP23). A public-style browse grid, not `shared/data-table.tsx`: that component is
 * built for an authenticated admin's list-with-row-actions (edit/delete/status), and a catalog is
 * "click a card to read more", closer to a product listing than a management table — reused shared
 * UI primitives (Card, Badge, Skeleton) instead, per this WP's DoD note that a public catalog may
 * warrant its own presentation.
 *
 * GAP, flagged rather than silently built around: the plan's acceptance text ("lists only
 * portal-visible products") assumes `Product` carries a visibility flag. It does not — no
 * published/visible/portalVisible column exists (schema.prisma), and there is no dashboard UI to
 * manage Products at all yet (WP18 shipped the backend only). This lists every product in the
 * developer's own tenant, which is the accurate, unfiltered result of what `ProductService.findAll`
 * actually returns today — see `PortalCatalogController.findProducts`'s own comment.
 */
export default function PortalCatalogPage() {
  const t = useTranslations('portal');
  const tCommon = useTranslations('common');
  const { data: products, isLoading, isError, error, refetch } = usePortalProducts();

  return (
    <div className="space-y-6">
      <PageHeader title={t('catalog.title')} description={t('catalog.subtitle')} />

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <StateCard role="alert" icon={<AlertTriangle className="text-destructive" aria-hidden="true" />} message={error.message}>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void refetch();
            }}
          >
            {tCommon('retry')}
          </Button>
        </StateCard>
      )}

      {!isLoading && !isError && products?.length === 0 && (
        <StateCard icon={<Package aria-hidden="true" />} message={t('catalog.empty')} />
      )}

      {!isLoading && !isError && products && products.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((product) => (
            <Link key={product.id} href={`/portal/products/${product.id}`} className="group block h-full rounded-lg">
              <Card className="flex h-full flex-col transition-colors duration-200 group-hover:border-primary/50">
                <CardHeader>
                  <CardTitle className="text-lg">{product.name}</CardTitle>
                  <CardDescription className="line-clamp-2">
                    {product.description ?? t('catalog.noDescription')}
                  </CardDescription>
                </CardHeader>
                <CardContent className="mt-auto flex items-center justify-between gap-2">
                  <Badge variant="secondary">{t('catalog.apiCount', { count: product.apis.length })}</Badge>
                  <ChevronRight
                    className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary rtl:rotate-180"
                    aria-hidden="true"
                  />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
