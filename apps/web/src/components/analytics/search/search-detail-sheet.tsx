'use client';

import { useId } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AnalyticsErrorState } from '@/components/analytics/analytics-empty-state';
import { HttpDumpSection } from '@/components/shared/http-dump-section';
import { FIGURE_LINK } from '@/components/shared/row-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useAnalyticsKeys } from '@/hooks/use-analytics';
import { useFormat } from '@/hooks/use-format';
import { useLastDefined } from '@/hooks/use-last-defined';
import { usePermissions } from '@/hooks/use-permissions';
import { useTrafficSearchDetail, type TrafficSearchItem } from '@/hooks/use-traffic-search';
import { focusReturn } from '@/lib/focus-return';
import { statusVariant } from '@/lib/http-status';
import { searchRequestKey, type SearchTarget } from '@/lib/search-target';
import { similarActions } from '@/lib/similar-request-tokens';
import { SEARCH_LIMITS } from '@/lib/traffic-search';
import type { AnalyticsRange } from '@/types';

interface SheetProps {
  /** The request to show; null keeps the sheet closed. It is all a shared link carries, so the row need not be on the page. */
  target: SearchTarget | null;
  /** That request's row when it is among the loaded results: its header shows at once, before the detail arrives. */
  listItem?: TrafficSearchItem;
  /** The search's window, for finding the key by its name among the keys that have traffic in it. */
  range: AnalyticsRange;
  /** The neighbouring loaded results; absent at the ends and for a request that is not among them. */
  previous?: TrafficSearchItem;
  next?: TrafficSearchItem;
  /** Where this request sits among the loaded results; absent when it is not among them. */
  position?: { index: number; count: number };
  /** The search as it stands (to see what is already filtered) and how to add a filter to it. */
  similar: { tokens: readonly string[]; onAdd: (text: string) => void };
  onNavigate: (item: TrafficSearchItem) => void;
  onClose: () => void;
}

/**
 * One search result in full: request and response, with the same renderer as the per-API inspector;
 * links to its API and key; "find similar" filters; and previous / next through the loaded results.
 */
export function SearchDetailSheet({ target, onClose, ...detail }: SheetProps) {
  // The URL empties the moment the sheet starts closing, but the sheet takes a moment to animate out:
  // it keeps showing the request it had, instead of an empty panel sliding away.
  const open = useLastDefined(target ? { target, ...detail } : null);
  return (
    <Sheet
      open={target !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-xl"
        // Focus goes back to the row of the request that is open now (it may have been opened by a click
        // on text, and stepping may have moved it), or to the page if that row is no longer listed.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusReturn(open ? searchRequestKey(open.target) : null);
        }}
      >
        {/* The content mounts only while the sheet is open, so its queries never run for a closed one. */}
        {open && <RequestDetail {...open} />}
      </SheetContent>
    </Sheet>
  );
}

function RequestDetail({
  target,
  listItem,
  range,
  previous,
  next,
  position,
  similar,
  onNavigate,
}: Omit<SheetProps, 'target' | 'onClose'> & { target: SearchTarget }) {
  const t = useTranslations('analytics.search.detail');
  const tSearch = useTranslations('analytics.search');
  const tTab = useTranslations('apis');
  const fmt = useFormat();
  const { can } = usePermissions();
  const { data, isLoading, error, refetch } = useTrafficSearchDetail(target);
  const keys = useAnalyticsKeys(range);
  // The loaded row until the detail arrives, then the detail (which is all there is for a shared link).
  const shown = data ?? listItem;
  // A key is found by its alias, which is its name: names are not unique (nothing stops two keys sharing
  // one), so a name that more than one key has links to neither rather than to the wrong one.
  const sameName = shown?.keyAlias ? (keys.data ?? []).filter((key) => key.name === shown.keyAlias) : [];
  const keyId = sameName.length === 1 ? sameName[0]?.apiKeyId : undefined;
  const actions = shown ? similarActions(shown, similar.tokens) : [];
  const blocked = actions.filter((action) => action.blocked !== null);
  // Each blocked action is described by its reason, so it is read with the button.
  const reasons = useId();
  const reasonId = (action: (typeof actions)[number]) =>
    `${reasons}-${action.blocked === 'full' ? 'full' : action.kind}`;

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex flex-wrap items-center gap-2">
          {shown ? (
            <>
              {/* `dir="ltr"` keeps a path readable in a right-to-left page; `overflow-wrap:anywhere` lets one
                  unbroken token wrap inside the sheet instead of widening it past the screen. */}
              <span dir="ltr" className="min-w-0 font-mono text-base [overflow-wrap:anywhere]">
                {shown.method} {shown.path}
              </span>
              <Badge variant={statusVariant(shown.status)}>{shown.status}</Badge>
            </>
          ) : (
            <span className="sr-only">{t('title')}</span>
          )}
        </SheetTitle>
        <SheetDescription>{t('redactionNote')}</SheetDescription>
      </SheetHeader>
      <div className="mt-4 space-y-5">
        {position && shown && (
          <div className="flex items-center justify-between gap-2">
            {/* aria-disabled, not disabled: at the end of the list the button that was just pressed keeps focus. */}
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t('previous')}
                aria-disabled={!previous || undefined}
                className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                onClick={() => {
                  if (previous) onNavigate(previous);
                }}
              >
                <ChevronLeft className="rtl:rotate-180" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t('next')}
                aria-disabled={!next || undefined}
                className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                onClick={() => {
                  if (next) onNavigate(next);
                }}
              >
                <ChevronRight className="rtl:rotate-180" aria-hidden="true" />
              </Button>
            </div>
            {/* The live text names the request now shown, so stepping is heard as well as seen. */}
            {/* The request is an isolated left-to-right run inside a sentence that may read right to left, and wraps anywhere. */}
            <span className="text-muted-foreground min-w-0 text-xs [overflow-wrap:anywhere]" aria-live="polite">
              {t.rich('position', {
                ...position,
                request: `${shown.method} ${shown.path}, ${String(shown.status)}`,
                bdi: (chunks) => <bdi dir="ltr">{chunks}</bdi>,
              })}
            </span>
          </div>
        )}
        {shown && (
          <p className="text-muted-foreground text-xs">
            {[fmt.dateTime(shown.ts), fmt.ms(shown.latencyMs), data?.ip].filter(Boolean).join(' · ')}
          </p>
        )}
        {shown && (Boolean(shown.apiId) || Boolean(shown.keyAlias)) && (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            {shown.apiId && shown.apiName && (
              <>
                <dt className="text-muted-foreground">{tSearch('columns.api')}</dt>
                <dd dir="auto" className="truncate">
                  {can('api:read') ? (
                    <Link href={`/apis/${shown.apiId}`} className={FIGURE_LINK}>
                      {shown.apiName}
                    </Link>
                  ) : (
                    shown.apiName
                  )}
                </dd>
              </>
            )}
            {shown.keyAlias && (
              <>
                <dt className="text-muted-foreground">{tSearch('columns.key')}</dt>
                <dd dir="ltr" className="truncate font-mono text-xs">
                  {/* The key is found by its name among the keys that have traffic in this window. */}
                  {keyId && can('key:read') ? (
                    <Link href={`/keys/${keyId}`} className={FIGURE_LINK}>
                      {shown.keyAlias}
                    </Link>
                  ) : (
                    shown.keyAlias
                  )}
                </dd>
              </>
            )}
          </dl>
        )}
        {shown && (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t('similarTitle')}</h3>
            <div className="flex flex-wrap gap-2">
              {actions.map((action) => (
                <Button
                  key={action.kind}
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-disabled={action.blocked !== null || undefined}
                  aria-describedby={action.blocked !== null ? reasonId(action) : undefined}
                  className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                  onClick={() => {
                    if (action.blocked === null && action.token !== null) similar.onAdd(action.token);
                  }}
                >
                  {t(`similar.${action.kind}`)}
                </Button>
              ))}
            </div>
            {/* An action that is off stays reachable and says why in text that describes it (a disabled
                button would show no tooltip and be skipped by the keyboard). */}
            {blocked.length > 0 && (
              <ul className="text-muted-foreground space-y-0.5 text-xs">
                {blocked.some((action) => action.blocked === 'full') ? (
                  <li id={`${reasons}-full`}>{t('similarBlocked.full', { max: SEARCH_LIMITS.maxClauses })}</li>
                ) : (
                  blocked.map((action) => (
                    <li key={action.kind} id={reasonId(action)}>
                      {t(`similarBlocked.${action.blocked === 'present' ? 'present' : 'unsupported'}`, {
                        action: t(`similar.${action.kind}`),
                      })}
                    </li>
                  ))
                )}
              </ul>
            )}
          </section>
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
    </>
  );
}
