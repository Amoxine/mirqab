'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Package } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('catalog.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('catalog.subtitle')}</p>
      </div>

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      )}

      {isError && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <AlertTriangle className="h-8 w-8 text-destructive" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{error.message}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void refetch();
              }}
            >
              {tCommon('retry')}
            </Button>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && products?.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Package className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{t('catalog.empty')}</p>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && products && products.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((product) => (
            <Link key={product.id} href={`/portal/products/${product.id}`} className="block h-full">
              <Card className="h-full transition-colors hover:border-primary/50">
                <CardHeader>
                  <CardTitle className="text-lg">{product.name}</CardTitle>
                  <CardDescription className="line-clamp-2">
                    {product.description ?? t('catalog.noDescription')}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Badge variant="secondary">{t('catalog.apiCount', { count: product.apis.length })}</Badge>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
