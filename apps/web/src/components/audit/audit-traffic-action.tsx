'use client';

import { useState } from 'react';
import { Activity } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { PermissionGate } from '@/components/auth/permission-gate';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { useFormat } from '@/hooks/use-format';
import type { AuditLogEntry } from '@/hooks/use-audit';
import type { AnalyticsRange } from '@/types';

/** The part of a `GET /audit-logs` row this action reads. */
export type AuditTrafficRow = Pick<AuditLogEntry, 'resource' | 'createdAt'> & {
  details: Record<string, unknown> | null;
};

/**
 * `GET /audit-logs/traffic/:apiDefId` response (V1-LOG-01, AC-LOG01.1): the same rollup fields
 * `AnalyticsApiRow` already reports for one API, scoped by the route to a single `apiDefId`.
 */
interface AuditTrafficSummary {
  requests: number;
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
}

const HOUR_MS = 3_600_000;

/**
 * The narrowest existing `AnalyticsRange` bucket that still covers the row's own moment, or `null`
 * when the row is older than the widest one (30 days, which is also the raw retention): every bucket
 * is "the last N from now", so for such a row it would show a window that does not contain the event.
 */
function rangeForRow(createdAt: string): AnalyticsRange | null {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  if (ageMs <= HOUR_MS) return '1h';
  if (ageMs <= 24 * HOUR_MS) return '24h';
  if (ageMs <= 7 * 24 * HOUR_MS) return '7d';
  if (ageMs <= 30 * 24 * HOUR_MS) return '30d';
  return null;
}

/**
 * Cross-link from an audit row of an `apis` resource to that API's traffic in the same window
 * (AC-LOG01.1-3). The id lives in `details.resourceId` (G3) — not a `resourceId` column. Gated on
 * `analytics:read`, hidden otherwise (AC-LOG01.2); server-side enforcement is the route's own guard,
 * this only avoids showing an action the user can't use.
 */
export function AuditTrafficAction({ row }: { row: AuditTrafficRow }) {
  const t = useTranslations('analytics');
  const fmt = useFormat();
  const [open, setOpen] = useState(false);

  const apiDefId =
    row.resource === 'apis' && typeof row.details?.resourceId === 'string' ? row.details.resourceId : undefined;
  const range = rangeForRow(row.createdAt);

  const { data, isLoading, isError } = useQuery({
    queryKey: [...queryKeys.audit.all, 'traffic', apiDefId, range] as const,
    queryFn: () => {
      // `enabled` below never lets this run without both; the check just narrows the types for the
      // URL template without a non-null assertion.
      if (apiDefId === undefined || range === null) throw new Error('unreachable: queryFn ran without apiDefId/range');
      return api.get<AuditTrafficSummary>(`/audit-logs/traffic/${apiDefId}?range=${range}`).then((res) => res.data);
    },
    enabled: open && apiDefId !== undefined && range !== null,
  });

  if (apiDefId === undefined || range === null) return null;

  return (
    <PermissionGate permission="analytics:read">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" title={t('auditLogs.viewTraffic')}>
            <Activity className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{t('auditLogs.viewTraffic')}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 space-y-2">
          <h4 className="font-medium">{t('auditLogs.viewTrafficTitle')}</h4>
          <p className="text-xs text-muted-foreground">{t(`ranges.${range}`)}</p>
          {isLoading && <p className="text-sm text-muted-foreground">{t('auditLogs.trafficLoading')}</p>}
          {isError && <p className="text-sm text-destructive">{t('auditLogs.trafficError')}</p>}
          {data && (
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t('table.columns.requests')}</dt>
              <dd className="text-end tabular-nums">{fmt.number(data.requests)}</dd>
              <dt className="text-muted-foreground">{t('table.columns.errors')}</dt>
              <dd className="text-end tabular-nums">{fmt.number(data.errors)}</dd>
              <dt className="text-muted-foreground">{t('table.columns.errorRate')}</dt>
              <dd className="text-end tabular-nums">{fmt.percent(data.errorRate)}</dd>
              <dt className="text-muted-foreground">{t('table.columns.avgLatency')}</dt>
              <dd className="text-end tabular-nums">{fmt.ms(data.avgLatencyMs)}</dd>
            </dl>
          )}
        </PopoverContent>
      </Popover>
    </PermissionGate>
  );
}
