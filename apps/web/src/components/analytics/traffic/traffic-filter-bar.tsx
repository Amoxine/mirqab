'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PageFilter, type FilterField, type FilterValues } from '@open-gateway/ui';
import { Button } from '@/components/ui/button';
import { useAnalyticsApis, useAnalyticsKeys } from '@/hooks/use-analytics';
import { useRangeOptions } from '@/hooks/use-range-options';
import { useTrafficSearchHref } from '@/hooks/use-traffic-search-href';
import type { TrafficFilters } from '@/types';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;
const LATENCY_STEPS = [100, 250, 500, 1000, 2000] as const;
/** How many rows `/analytics/apis` and `/analytics/keys` answer by default (the busiest first): a list this long may be cut. */
const LIST_CAP = 50;

interface TrafficFilterBarProps {
  filters: TrafficFilters;
  onChange: (patch: Partial<TrafficFilters>) => void;
  onReset: () => void;
}

/**
 * The traffic page's filters, as data for the shared `PageFilter`: this file only supplies the
 * translated labels and the option lists (APIs, and the keys of the chosen API). The URL state,
 * the "picking an API clears the key" rule and the query live in `useTrafficFilters`.
 *
 * The option lists are the analytics ones (the APIs and keys with their traffic, busiest first), which
 * need only `analytics:read`, the permission of this page: the API and key lists need `api:read` and
 * `key:read`, which an analyst may not hold. Those lists are capped, so a selection that is not in them
 * (a shared link) is still offered, and the cap is said; a list that cannot load is said too.
 */
export function TrafficFilterBar({ filters, onChange, onReset }: TrafficFilterBarProps) {
  const t = useTranslations('analytics.traffic.filters');
  const tClasses = useTranslations('analytics.traffic.statusClasses');
  const tAnalytics = useTranslations('analytics');
  const rangeOptions = useRangeOptions();
  const apis = useAnalyticsApis(filters.range);
  const keys = useAnalyticsKeys(filters.range);
  const searchHref = useTrafficSearchHref(filters);

  const apiOptions = useMemo(() => {
    const options = (apis.data ?? []).map((api) => ({ value: api.apiDefId, label: api.name }));
    if (filters.apiId && !options.some((option) => option.value === filters.apiId)) {
      options.push({ value: filters.apiId, label: t('selectedApi') });
    }
    return options;
  }, [apis.data, filters.apiId, t]);
  const keyOptions = useMemo(() => {
    const all = keys.data ?? [];
    // The keys of the chosen API: a key row names its API (not its id), so by name, and every key when
    // that API is not in the list to take the name from.
    const apiName = (apis.data ?? []).find((api) => api.apiDefId === filters.apiId)?.name;
    const options = all
      .filter((key) => apiName === undefined || key.apiDefName === apiName)
      .map((key) => ({ value: key.apiKeyId, label: key.name }));
    if (filters.keyId && !options.some((option) => option.value === filters.keyId)) {
      options.push({
        value: filters.keyId,
        label: all.find((key) => key.apiKeyId === filters.keyId)?.name ?? t('selectedKey'),
      });
    }
    return options;
  }, [apis.data, keys.data, filters.apiId, filters.keyId, t]);
  const notes = [
    apis.isError ? t('apisUnavailable') : null,
    keys.isError ? t('keysUnavailable') : null,
    (apis.data?.length ?? 0) >= LIST_CAP || (keys.data?.length ?? 0) >= LIST_CAP
      ? t('listTruncated', { count: LIST_CAP })
      : null,
  ].filter((note) => note !== null);

  const fields = useMemo<FilterField[]>(
    () => [
      {
        type: 'segmented',
        key: 'range',
        label: tAnalytics('rangeLabel'),
        options: rangeOptions,
      },
      {
        type: 'select',
        key: 'apiId',
        label: t('api'),
        allLabel: t('allApis'),
        options: apiOptions,
      },
      {
        type: 'select',
        key: 'keyId',
        label: t('key'),
        allLabel: t('allKeys'),
        options: keyOptions,
      },
      {
        type: 'select',
        key: 'method',
        label: t('method'),
        allLabel: t('allMethods'),
        options: METHODS.map((method) => ({ value: method, label: method })),
      },
      {
        type: 'select',
        key: 'statusClass',
        label: t('statusClass'),
        allLabel: t('allStatuses'),
        options: STATUS_CLASSES.map((cls) => ({ value: cls, label: tClasses(cls) })),
      },
      {
        type: 'select',
        key: 'auth',
        label: t('auth'),
        allLabel: t('allTraffic'),
        options: [
          { value: 'authenticated', label: t('authenticated') },
          { value: 'anonymous', label: t('anonymous') },
        ],
      },
      {
        type: 'select',
        key: 'minLatencyMs',
        label: t('minLatency'),
        allLabel: t('anyLatency'),
        valueType: 'number',
        options: LATENCY_STEPS.map((ms) => ({
          value: String(ms),
          label: t('slowerThan', { ms }),
        })),
      },
      {
        type: 'number',
        key: 'status',
        label: t('statusCode'),
        placeholder: t('statusCodePlaceholder'),
        min: 100,
        max: 599,
      },
      {
        type: 'search',
        key: 'path',
        label: t('path'),
        placeholder: t('pathPlaceholder'),
        maxLength: 200,
        dir: 'ltr',
      },
    ],
    [t, tClasses, tAnalytics, rangeOptions, apiOptions, keyOptions],
  );

  const values: FilterValues = { ...filters };
  // The same filters, as a request search: the list of requests behind the figures on this page.
  const requestsHref = searchHref();

  return (
    <div className="space-y-2">
      <PageFilter
        fields={fields}
        values={values}
        // Every key in the patch is a field key above, i.e. a `TrafficFilters` key with a value of the
        // type its control produces (ranges from the segmented options, numbers from number fields…).
        onChange={(patch) => {
          onChange(patch as Partial<TrafficFilters>);
        }}
        onReset={onReset}
        labels={{
          title: t('title'),
          reset: t('reset'),
          active: (count) => t('active', { count }),
        }}
      />
      {notes.length > 0 && (
        <p role="status" className="text-muted-foreground text-xs">
          {notes.join(' ')}
        </p>
      )}
      {requestsHref && (
        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link href={requestsHref}>
              <Search aria-hidden="true" />
              {t('viewRequests')}
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
