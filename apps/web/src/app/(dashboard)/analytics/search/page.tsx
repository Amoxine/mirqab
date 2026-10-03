'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { PagePermissionGate } from '@/components/auth/permission-gate';
import { SearchBar } from '@/components/analytics/search/search-bar';
import { SearchDetailSheet } from '@/components/analytics/search/search-detail-sheet';
import { SearchResults } from '@/components/analytics/search/search-results';
import { RangeControl } from '@/components/dashboard/range-control';
import { PageHeader } from '@/components/shared/page-header';
import { Notice } from '@open-gateway/ui';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useOpenRequest } from '@/hooks/use-open-request';
import { useSearchQuery } from '@/hooks/use-search-query';
import { useTrafficSearch } from '@/hooks/use-traffic-search';

function SearchView() {
  const t = useTranslations('analytics.search');
  const search = useSearchQuery();
  const result = useTrafficSearch(search.range, search.clauses, search.ready);

  const pages = result.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const indexedUntil = pages.at(-1)?.indexedUntil ?? null;
  const indexedFrom = pages.at(-1)?.indexedFrom ?? null;
  const coverage = pages.at(-1)?.coverage;
  // The open request lives in the URL (`?req=&ts=`), so a link to it opens it, loaded or not.
  const request = useOpenRequest(items, search);

  return (
    <div className="space-y-3">
      <PageHeader title={t('title')} description={t('description')} actions={<RangeControl value={search.range} onChange={search.setRange} />} />
      {/* A shared link with a range this page does not know searches the default; saying so keeps its meaning honest. */}
      {search.rangeUnknown && <Notice role="status" tone="info">{t('rangeUnknown')}</Notice>}
      <Card className="space-y-4 p-4">
        <SearchBar
          tokens={search.tokens}
          tooMany={search.tooMany}
          range={search.range}
          onAdd={search.add}
          onRemove={search.remove}
          onPreset={search.replaceAll}
        />
        {search.ready ? (
          <SearchResults
            items={items}
            isLoading={result.isLoading}
            isRefetching={result.isPlaceholderData}
            // A later page that failed leaves the loaded rows alone: only a failure with nothing to show is the whole view.
            error={result.isFetchNextPageError ? null : result.error}
            loadMoreError={result.isFetchNextPageError ? result.error : null}
            hasMore={result.hasNextPage}
            isFetchingMore={result.isFetchingNextPage}
            hasFilters={search.clauses.length > 0}
            filterCount={search.clauses.length}
            indexedUntil={indexedUntil}
            indexedFrom={indexedFrom}
            coverage={coverage}
            onLoadMore={() => void result.fetchNextPage()}
            onRetry={() => void result.refetch()}
            onOpen={request.open}
            getHref={request.hrefTo}
          />
        ) : null}
      </Card>
      <SearchDetailSheet
        target={request.target}
        listItem={request.listItem}
        range={search.range}
        previous={request.previous}
        next={request.next}
        position={request.position}
        similar={{
          tokens: search.tokens.map((token) => token.text),
          // The filter changes the search under the sheet, so the sheet closes once it has.
          onAdd: request.addFilter,
        }}
        onNavigate={request.open}
        onClose={request.close}
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
