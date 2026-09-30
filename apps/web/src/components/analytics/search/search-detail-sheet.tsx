'use client';

import { useTranslations } from 'next-intl';
import { AnalyticsErrorState } from '@/components/analytics/analytics-empty-state';
import { HttpDumpSection } from '@/components/shared/http-dump-section';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/hooks/use-format';
import { useTrafficSearchDetail, type TrafficSearchItem } from '@/hooks/use-traffic-search';
import { statusVariant } from '@/lib/http-status';

/** One search result in full: request and response, with the same renderer as the per-API inspector. */
export function SearchDetailSheet({ item, onClose }: { item: TrafficSearchItem | null; onClose: () => void }) {
  const t = useTranslations('analytics.search.detail');
  const tTab = useTranslations('apis');
  const fmt = useFormat();
  const { data, isLoading, error, refetch } = useTrafficSearchDetail(item);

  return (
    <Sheet
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {item && (
              <>
                <span dir="ltr" className="font-mono text-base">
                  {item.method} {item.path}
                </span>
                <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
              </>
            )}
          </SheetTitle>
          <SheetDescription>{t('redactionNote')}</SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-5">
          {item && (
            <p className="text-muted-foreground text-xs">
              {[fmt.dateTime(item.ts), fmt.ms(item.latencyMs), data?.ip].filter(Boolean).join(' · ')}
            </p>
          )}
          {isLoading && <Skeleton className="h-48 w-full" aria-busy="true" />}
          {error && <AnalyticsErrorState message={t('loadError')} onRetry={() => void refetch()} />}
          {data && (
            <>
              <HttpDumpSection
                label={tTab('trafficTab.request')}
                dump={{ startLine: `${data.method} ${data.path}`, headers: data.reqHeaders, body: data.reqBody, truncated: data.reqTruncated }}
                empty={tTab('trafficTab.noRequest')}
                truncatedLabel={tTab('trafficTab.truncated')}
              />
              <HttpDumpSection
                label={tTab('trafficTab.response')}
                dump={{ startLine: String(data.status), headers: data.resHeaders, body: data.resBody, truncated: data.resTruncated }}
                empty={tTab('trafficTab.noResponse')}
                truncatedLabel={tTab('trafficTab.truncated')}
              />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
