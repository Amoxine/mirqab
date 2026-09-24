'use client';

import { useMemo } from 'react';
import { type ColumnDef, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/sonner';
import { DataTable } from '@/components/shared/data-table';
import { useNodeHealth, useReloadGateways, useSettings } from '@/hooks/use-settings';
import type { NodeHealthEntry } from '@/types';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-3 text-sm last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

function GeneralTab() {
  const t = useTranslations('settings.general');
  const tSettings = useTranslations('settings');
  const tCommon = useTranslations('common');
  const { data, isLoading, isError, refetch } = useSettings();

  if (isLoading) {
    return (
      <Card>
        <CardContent className="space-y-3 pt-6">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-muted-foreground">{tSettings('loadError')}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
            {tCommon('retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <dl>
          <Row label={t('tykOrgId')}>
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{data.tykOrgId}</code>
          </Row>
          <Row label={t('analyticsRetentionDays')}>{t('daysValue', { count: data.analyticsRetentionDays })}</Row>
          <Row label={t('analyticsAggregateRetentionDays')}>
            {t('daysValue', { count: data.analyticsAggregateRetentionDays })}
          </Row>
        </dl>
      </CardContent>
    </Card>
  );
}

function nodeColumns(t: ReturnType<typeof useTranslations>): ColumnDef<NodeHealthEntry>[] {
  return [
    { accessorKey: 'nodeUrl', header: t('columns.node') },
    {
      id: 'status',
      header: t('columns.status'),
      cell: ({ row }) =>
        row.original.health.reachable ? (
          <Badge className="border-transparent bg-success text-white">{t('reachable')}</Badge>
        ) : (
          <Badge variant="destructive">{t('unreachable')}</Badge>
        ),
    },
    {
      id: 'version',
      header: t('columns.version'),
      cell: ({ row }) => row.original.health.version ?? '—',
    },
    {
      id: 'latency',
      header: t('columns.latency'),
      cell: ({ row }) =>
        row.original.health.latencyMs === null ? '—' : `${String(row.original.health.latencyMs)} ms`,
    },
  ];
}

function NodesTab() {
  const t = useTranslations('settings.nodes');
  const { data, isLoading, isError, error, refetch } = useNodeHealth();
  const reload = useReloadGateways();
  const columns = useMemo(() => nodeColumns(t), [t]);

  const table = useReactTable({
    data: data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const handleReload = () => {
    reload.mutate(undefined, {
      onSuccess: (outcomes) => {
        const ok = outcomes.filter((o) => o.ok).length;
        toast.success(t('reloadResult', { ok, total: outcomes.length }));
      },
      onError: (err) => {
        toast.error(err instanceof Error ? err.message : t('reloadError'));
      },
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardDescription>{t('description')}</CardDescription>
        <PermissionGate permission="settings:update">
          <Button type="button" size="sm" onClick={handleReload} disabled={reload.isPending}>
            <RefreshCw className={`me-2 h-4 w-4 ${reload.isPending ? 'animate-spin' : ''}`} aria-hidden="true" />
            {reload.isPending ? t('reloadingButton') : t('reloadButton')}
          </Button>
        </PermissionGate>
      </CardHeader>
      <CardContent>
        <DataTable
          table={table}
          isLoading={isLoading}
          isError={isError}
          error={error}
          onRetry={() => void refetch()}
          emptyMessage={t('empty')}
        />
      </CardContent>
    </Card>
  );
}

function SettingsView() {
  const t = useTranslations('settings');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">{t('tabs.general')}</TabsTrigger>
          <TabsTrigger value="nodes">{t('tabs.nodes')}</TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="mt-4">
          <GeneralTab />
        </TabsContent>
        <TabsContent value="nodes" className="mt-4">
          <NodesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <PagePermissionGate permission="settings:read">
      <SettingsView />
    </PagePermissionGate>
  );
}
