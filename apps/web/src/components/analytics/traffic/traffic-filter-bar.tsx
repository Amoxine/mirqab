'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { PageFilter, type FilterField, type FilterValues } from '@open-gateway/ui';
import { useApis } from '@/hooks/use-apis';
import { useKeys } from '@/hooks/use-keys';
import { useRangeOptions } from '@/hooks/use-range-options';
import type { TrafficFilters } from '@/types';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;
const LATENCY_STEPS = [100, 250, 500, 1000, 2000] as const;

interface TrafficFilterBarProps {
  filters: TrafficFilters;
  onChange: (patch: Partial<TrafficFilters>) => void;
  onReset: () => void;
}

/**
 * The traffic page's filters, as data for the shared `PageFilter`: this file only supplies the
 * translated labels and the option lists (APIs, and the keys of the chosen API). The URL state,
 * the "picking an API clears the key" rule and the query live in `useTrafficFilters`.
 */
export function TrafficFilterBar({ filters, onChange, onReset }: TrafficFilterBarProps) {
  const t = useTranslations('analytics.traffic.filters');
  const tClasses = useTranslations('analytics.traffic.statusClasses');
  const tAnalytics = useTranslations('analytics');
  const rangeOptions = useRangeOptions();
  const apis = useApis(1, 100);
  const keys = useKeys(1, 100, undefined, filters.apiId);

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
        options: (apis.data?.data ?? []).map((api) => ({ value: api.id, label: api.name })),
      },
      {
        type: 'select',
        key: 'keyId',
        label: t('key'),
        allLabel: t('allKeys'),
        options: (keys.data?.data ?? []).map((key) => ({ value: key.id, label: key.name })),
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
    [t, tClasses, tAnalytics, rangeOptions, apis.data, keys.data],
  );

  const values: FilterValues = { ...filters };

  return (
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
  );
}
