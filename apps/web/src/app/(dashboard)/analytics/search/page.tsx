'use client';

import { Suspense, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PagePermissionGate } from '@/components/auth/permission-gate';
import { SearchBar } from '@/components/analytics/search/search-bar';
import { SearchDetailSheet } from '@/components/analytics/search/search-detail-sheet';
import { SearchResults } from '@/components/analytics/search/search-results';
import { RangeControl } from '@/components/dashboard/range-control';
import { PageHeader } from '@/components/shared/page-header';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSearchQuery } from '@/hooks/use-search-query';
import { useTrafficSearch, type TrafficSearchItem } from '@/hooks/use-traffic-search';

function SearchView() {
  const t = useTranslations('analytics.search');
  const search = useSearchQuery();
  const [open, setOpen] = useState<TrafficSearchItem | null>(null);
  const result = useTrafficSearch(search.range, search.clauses, search.ready);

  const pages = result.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const indexedUntil = pages.at(-1)?.indexedUntil ?? null;

  return (
    <div className="space-y-3">
      <PageHeader title={t('title')} description={t('description')} actions={<RangeControl value={search.range} onChange={search.setRange} />} />
      <Card className="space-y-4 p-4">
        <SearchBar
          tokens={search.tokens}
          tooMany={search.tooMany}
          onAdd={search.add}
          onRemove={search.remove}
          onPreset={search.replaceAll}
        />
        {search.ready ? (
          <SearchResults
            items={items}
            isLoading={result.isLoading}
            isRefetching={result.isPlaceholderData}
            error={result.error}
            hasMore={result.hasNextPage}
            isFetchingMore={result.isFetchingNextPage}
            hasFilters={search.clauses.length > 0}
            indexedUntil={indexedUntil}
            onLoadMore={() => void result.fetchNextPage()}
            onRetry={() => void result.refetch()}
            onOpen={setOpen}
          />
        ) : null}
      </Card>
      <SearchDetailSheet
        item={open}
        onClose={() => {
          setOpen(null);
        }}
      />
    </div>
  );
}

export default function TrafficSearchPage() {
  return (
    <PagePermissionGate permission={['analytics:read', 'api:update']}>
      {/* `useSearchParams` (the search lives in the URL) needs a Suspense boundary for static rendering. */}
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-[1.25rem]" />}>
        <SearchView />
      </Suspense>
    </PagePermissionGate>
  );
}
