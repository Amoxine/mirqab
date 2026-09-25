'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { type ColumnDef, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ChevronRight, FileKey, RefreshCw, Shield } from 'lucide-react';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/sonner';
import { DataTable } from '@/components/shared/data-table';
import { PageHeader } from '@/components/shared/page-header';
import { StateCard } from '@/components/shared/state-card';
import { useNodeHealth, useReloadGateways, useSettings } from '@/hooks/use-settings';
import type { NodeHealthEntry } from '@/types';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b py-3 text-sm last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-medium">{children}</dd>
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
      <StateCard
        role="alert"
        icon={<AlertTriangle className="text-destructive" aria-hidden="true" />}
        message={tSettings('loadError')}
      >
        <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
          {tCommon('retry')}
        </Button>
      </StateCard>
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
          <Badge variant="success">{t('reachable')}</Badge>
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
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardDescription>{t('description')}</CardDescription>
        <PermissionGate permission="settings:update">
          <Button type="button" size="sm" onClick={handleReload} disabled={reload.isPending}>
            <RefreshCw className={`h-4 w-4 ${reload.isPending ? 'animate-spin' : ''}`} aria-hidden="true" />
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

/** Roles and Certificates are each their own page (DataTable + Sheet, not a same-page tab) —
 * linked from here rather than added as more TabsTriggers. */
function SettingsLinkCard({
  href,
  permission,
  icon: Icon,
  title,
  description,
}: {
  href: string;
  permission: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  description: string;
}) {
  return (
    <PermissionGate permission={permission}>
      <Link href={href} className="block rounded-lg">
        <Card className="transition-colors duration-200 hover:bg-accent/50">
          <CardContent className="flex items-center justify-between gap-4 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
              <div>
                <CardTitle className="text-base">{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
          </CardContent>
        </Card>
      </Link>
    </PermissionGate>
  );
}

function SettingsView() {
  const t = useTranslations('settings');

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <div className="grid gap-4 md:grid-cols-2">
        <SettingsLinkCard
          href="/settings/roles"
          permission="role:read"
          icon={Shield}
          title={t('rolesCard.title')}
          description={t('rolesCard.description')}
        />
        <SettingsLinkCard
          href="/settings/certificates"
          permission="cert:read"
          icon={FileKey}
          title={t('certificatesCard.title')}
          description={t('certificatesCard.description')}
        />
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
