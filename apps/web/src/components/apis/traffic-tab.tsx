'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { MethodBadge } from '@/components/apis/endpoints/method-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RangeControl } from '@/components/dashboard/range-control';
import { DataTable } from '@/components/shared/data-table';
import { StateMessage } from '@/components/shared/state-card';
import { FormattedDateTime } from '@/components/shared/formatted';
import { useApiTraffic, type TrafficEntry } from '@/hooks/use-apis';
import { HttpDumpSection } from '@/components/shared/http-dump-section';
import { statusVariant } from '@/lib/http-status';
import type { AnalyticsRange } from '@/types';

const NO_ROWS: TrafficEntry[] = [];

function TrafficDetailDialog({
  entry,
  onClose,
}: {
  entry: TrafficEntry | null;
  onClose: () => void;
}) {
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
            <HttpDumpSection
              label={t('trafficTab.request')}
              dump={entry.request}
              empty={t('trafficTab.noRequest')}
              truncatedLabel={t('trafficTab.truncated')}
            />
            <HttpDumpSection
              label={t('trafficTab.response')}
              dump={entry.response}
              empty={t('trafficTab.noResponse')}
              truncatedLabel={t('trafficTab.truncated')}
            />
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
      cell: ({ row }) => <MethodBadge method={row.original.method} />,
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
        <Badge variant={statusVariant(row.original.responseCode)}>
          {row.original.responseCode}
        </Badge>
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
        <p className="text-muted-foreground text-sm">{t('trafficTab.description')}</p>
        <RangeControl
          value={range}
          onChange={(next) => {
            setRange(next);
            setPage(1);
          }}
        />
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
          <p className="text-muted-foreground text-sm">{t('trafficTab.pageLabel', { page })}</p>
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
