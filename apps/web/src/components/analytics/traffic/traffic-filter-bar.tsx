'use client';

import { useEffect, useState } from 'react';
import { FilterX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { RangeControl } from '@/components/dashboard/range-control';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useApis } from '@/hooks/use-apis';
import { useKeys } from '@/hooks/use-keys';
import { activeFilterCount } from '@/hooks/use-traffic-filters';
import type { TrafficFilters } from '@/types';

const ALL = 'all';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;
const LATENCY_STEPS = [100, 250, 500, 1000, 2000] as const;
/** Typing in the path box waits this long before it re-queries. */
const PATH_DEBOUNCE_MS = 350;

interface TrafficFilterBarProps {
  filters: TrafficFilters;
  onChange: (patch: Partial<TrafficFilters>) => void;
  onReset: () => void;
}

/** One labelled control of the bar; the label is real text so every control has an accessible name. */
function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <Label
        htmlFor={id}
        className="text-muted-foreground font-mono text-[0.66rem] font-normal uppercase tracking-[0.08em]"
      >
        {label}
      </Label>
      {children}
    </div>
  );
}

/** A select with an "all" entry; `undefined` means no filter. */
function FilterSelect({
  id,
  value,
  onChange,
  allLabel,
  options,
}: {
  id: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  allLabel: string;
  options: { value: string; label: string }[];
}) {
  return (
    <Select
      value={value ?? ALL}
      onValueChange={(next) => {
        onChange(next === ALL ? undefined : next);
      }}
    >
      <SelectTrigger id={id} className="h-9 w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Every filter of the traffic view. Each change goes straight to the URL (see `useTrafficFilters`),
 * so there is no Apply button: the numbers below follow the controls.
 */
export function TrafficFilterBar({ filters, onChange, onReset }: TrafficFilterBarProps) {
  const t = useTranslations('analytics.traffic.filters');
  const tClasses = useTranslations('analytics.traffic.statusClasses');
  const apis = useApis(1, 100);
  const keys = useKeys(1, 100, undefined, filters.apiId);
  const active = activeFilterCount(filters);

  // Typed inputs keep a local draft and push to the URL after a pause, so typing is not one query per key.
  const [pathDraft, setPathDraft] = useState(filters.path ?? '');
  const [statusDraft, setStatusDraft] = useState(
    filters.status === undefined ? '' : String(filters.status),
  );
  useEffect(() => {
    setPathDraft(filters.path ?? '');
  }, [filters.path]);
  useEffect(() => {
    setStatusDraft(filters.status === undefined ? '' : String(filters.status));
  }, [filters.status]);
  useEffect(() => {
    if (pathDraft === (filters.path ?? '')) return;
    const id = window.setTimeout(() => {
      onChange({ path: pathDraft.trim() || undefined });
    }, PATH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(id);
    };
  }, [pathDraft, filters.path, onChange]);
  useEffect(() => {
    if (statusDraft === (filters.status === undefined ? '' : String(filters.status))) return;
    const id = window.setTimeout(() => {
      const n = Number(statusDraft);
      onChange({
        status:
          statusDraft.trim() !== '' && Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined,
      });
    }, PATH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(id);
    };
  }, [statusDraft, filters.status, onChange]);

  return (
    <Card className="space-y-3 p-3.5" role="search" aria-label={t('title')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <RangeControl
          value={filters.range}
          onChange={(range) => {
            onChange({ range });
          }}
        />
        <div className="flex items-center gap-2">
          {active > 0 && (
            <span className="text-muted-foreground text-xs" role="status">
              {t('active', { count: active })}
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={active === 0}
            onClick={onReset}
          >
            <FilterX className="h-4 w-4" aria-hidden="true" />
            {t('reset')}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="tf-api" label={t('api')}>
          <FilterSelect
            id="tf-api"
            value={filters.apiId}
            onChange={(apiId) => {
              onChange({ apiId });
            }}
            allLabel={t('allApis')}
            options={(apis.data?.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
          />
        </Field>
        <Field id="tf-key" label={t('key')}>
          <FilterSelect
            id="tf-key"
            value={filters.keyId}
            onChange={(keyId) => {
              onChange({ keyId });
            }}
            allLabel={t('allKeys')}
            options={(keys.data?.data ?? []).map((k) => ({ value: k.id, label: k.name }))}
          />
        </Field>
        <Field id="tf-method" label={t('method')}>
          <FilterSelect
            id="tf-method"
            value={filters.method}
            onChange={(method) => {
              onChange({ method });
            }}
            allLabel={t('allMethods')}
            options={METHODS.map((m) => ({ value: m, label: m }))}
          />
        </Field>
        <Field id="tf-class" label={t('statusClass')}>
          <FilterSelect
            id="tf-class"
            value={filters.statusClass}
            onChange={(statusClass) => {
              onChange({ statusClass: statusClass as TrafficFilters['statusClass'] });
            }}
            allLabel={t('allStatuses')}
            options={STATUS_CLASSES.map((c) => ({ value: c, label: tClasses(c) }))}
          />
        </Field>
        <Field id="tf-auth" label={t('auth')}>
          <FilterSelect
            id="tf-auth"
            value={filters.auth}
            onChange={(auth) => {
              onChange({ auth: auth as TrafficFilters['auth'] });
            }}
            allLabel={t('allTraffic')}
            options={[
              { value: 'authenticated', label: t('authenticated') },
              { value: 'anonymous', label: t('anonymous') },
            ]}
          />
        </Field>
        <Field id="tf-latency" label={t('minLatency')}>
          <FilterSelect
            id="tf-latency"
            value={filters.minLatencyMs === undefined ? undefined : String(filters.minLatencyMs)}
            onChange={(v) => {
              onChange({ minLatencyMs: v === undefined ? undefined : Number(v) });
            }}
            allLabel={t('anyLatency')}
            options={LATENCY_STEPS.map((ms) => ({
              value: String(ms),
              label: t('slowerThan', { ms }),
            }))}
          />
        </Field>
        <Field id="tf-status" label={t('statusCode')}>
          <Input
            id="tf-status"
            inputMode="numeric"
            className="h-9"
            dir="ltr"
            value={statusDraft}
            placeholder={t('statusCodePlaceholder')}
            onChange={(e) => {
              setStatusDraft(e.target.value.replace(/\D/g, '').slice(0, 3));
            }}
          />
        </Field>
        <Field id="tf-path" label={t('path')}>
          <Input
            id="tf-path"
            type="search"
            className="h-9"
            dir="ltr"
            maxLength={200}
            value={pathDraft}
            placeholder={t('pathPlaceholder')}
            onChange={(e) => {
              setPathDraft(e.target.value);
            }}
          />
        </Field>
      </div>
    </Card>
  );
}
