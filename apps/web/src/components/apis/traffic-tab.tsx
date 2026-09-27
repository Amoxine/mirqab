'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable } from '@/components/shared/data-table';
import { StateMessage } from '@/components/shared/state-card';
import { FormattedDateTime } from '@/components/shared/formatted';
import { useApiTraffic, type HttpDump, type TrafficEntry } from '@/hooks/use-apis';
import type { AnalyticsRange } from '@/types';

const NO_ROWS: TrafficEntry[] = [];
const RANGES: AnalyticsRange[] = ['1h', '24h', '7d', '30d'];

function statusVariant(code: number): 'default' | 'secondary' | 'destructive' {
  if (code >= 500) return 'destructive';
  if (code >= 400) return 'secondary';
  return 'default';
}

/** One request or response side of the detail dialog: its start line, headers, then its body. */
function DumpSection({ label, dump, empty }: { label: string; dump: HttpDump | null; empty: string }) {
  const t = useTranslations('apis');
  if (!dump) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{label}</h3>
        <p className="text-xs text-muted-foreground">{empty}</p>
      </div>
    );
  }
  const entries = Object.entries(dump.headers);
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{label}</h3>
      <p className="break-all font-mono text-xs">{dump.startLine}</p>
      {entries.length > 0 && (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
          {entries.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="font-mono text-muted-foreground">{name}</dt>
              <dd className="min-w-0 break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {dump.body && <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">{dump.body}</pre>}
      {dump.truncated && <p className="text-xs text-muted-foreground">{t('trafficTab.truncated')}</p>}
    </div>
  );
}

function TrafficDetailDialog({ entry, onClose }: { entry: TrafficEntry | null; onClose: () => void }) {
  const t = useTranslations('apis');

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('trafficTab.detailTitle')}</DialogTitle>
          <DialogDescription>{t('trafficTab.redactionNote')}</DialogDescription>
        </DialogHeader>
        {entry && (
          <div className="space-y-4">
            <DumpSection label={t('trafficTab.request')} dump={entry.request} empty={t('trafficTab.noRequest')} />
            <DumpSection label={t('trafficTab.response')} dump={entry.response} empty={t('trafficTab.noResponse')} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * V1-LOG-02: reads back what `detailedRecording` (Designer's `DetailedRecordingSheet`) has been
 * capturing — nothing did before this tab existed. `NOT_ENABLED` and `FAILED` are distinct empty
 * states from a page with zero rows (AC-LOG02.4): the former means recording is off *and* nothing
 * was ever captured; the latter means the capture store itself could not be read.
 */
export function TrafficTab({ apiId }: { apiId: string }) {
  const t = useTranslations('apis');
  const tCommon = useTranslations('common');
  const tTable = useTranslations('dashboard.dataTable');
  const [range, setRange] = useState<AnalyticsRange>('24h');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<TrafficEntry | null>(null);
  const { data, isLoading, isError, error, refetch } = useApiTraffic(apiId, range, page);

  const columns: ColumnDef<TrafficEntry>[] = [
    {
      accessorKey: 'timestamp',
      header: t('trafficTab.timestamp'),
      cell: ({ row }) => <FormattedDateTime value={row.original.timestamp} />,
    },
    {
      accessorKey: 'method',
      header: t('trafficTab.method'),
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.method}</span>,
    },
    {
      accessorKey: 'path',
      header: t('trafficTab.path'),
      cell: ({ row }) => <span className="break-all font-mono text-xs">{row.original.path}</span>,
    },
    {
      accessorKey: 'responseCode',
      header: t('trafficTab.status'),
      cell: ({ row }) => (
        <Badge variant={statusVariant(row.original.responseCode)}>{row.original.responseCode}</Badge>
      ),
    },
    {
      id: 'actions',
      header: t('trafficTab.view'),
      cell: ({ row }) => (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setDetail(row.original);
          }}
        >
          <Eye className="h-4 w-4" aria-hidden="true" />
          {t('trafficTab.view')}
        </Button>
      ),
    },
  ];

  const rows = data?.status === 'OK' ? data.items : NO_ROWS;
  // Hooks run unconditionally on every render — the NOT_ENABLED/FAILED early returns happen after.
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() });

  if (data?.status === 'NOT_ENABLED') {
    return (
      <StateMessage
        icon={<EyeOff aria-hidden="true" />}
        title={t('trafficTab.notEnabledTitle')}
        message={t('trafficTab.notEnabledMessage')}
      />
    );
  }

  if (data?.status === 'FAILED') {
    return (
      <StateMessage
        role="alert"
        icon={<AlertTriangle className="text-destructive" aria-hidden="true" />}
        title={t('trafficTab.failedTitle')}
        message={t('trafficTab.failedMessage')}
      >
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void refetch();
          }}
        >
          {tCommon('retry')}
        </Button>
      </StateMessage>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('trafficTab.description')}</p>
        <Select
          value={range}
          onValueChange={(v) => {
            setRange(v as AnalyticsRange);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full sm:w-[180px]" aria-label={t('trafficTab.rangeLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((r) => (
              <SelectItem key={r} value={r}>
                {t(`trafficTab.ranges.${r}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        table={table}
        isLoading={isLoading}
        isError={isError}
        error={error}
        onRetry={() => void refetch()}
        emptyMessage={t('trafficTab.empty')}
        skeletonRows={3}
      />

      {data?.status === 'OK' && (page > 1 || data.hasMore) && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">{t('trafficTab.pageLabel', { page })}</p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => {
                setPage((p) => Math.max(1, p - 1));
              }}
            >
              {tTable('previous')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!data.hasMore}
              onClick={() => {
                setPage((p) => p + 1);
              }}
            >
              {tTable('next')}
            </Button>
          </div>
        </div>
      )}

      <TrafficDetailDialog
        entry={detail}
        onClose={() => {
          setDetail(null);
        }}
      />
    </div>
  );
}
