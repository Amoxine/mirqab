'use client';

import { Notice } from '@open-gateway/ui';
import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
} from '@tanstack/react-table';
import { AlertTriangle, ChevronDown, FileUp, FileX, Pencil, Eye } from 'lucide-react';
import { SyncStatusBadge } from '@/components/apis/sync-status-badge';
import { toastSyncOutcome } from '@/components/apis/sync-outcome-toast';
import { SpecSourceCard } from '@/components/apis/spec-source/spec-source-card';
import { SpecUpdateBanner } from '@/components/apis/spec-source/spec-update-banner';
import { SpecUpdateSheet } from '@/components/apis/spec-update/spec-update-sheet';
import {
  DataTable,
  DataTablePagination,
  useViewMode,
  ViewModeToggle,
} from '@/components/shared/data-table';
import { StateCard } from '@/components/shared/state-card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { PageFilter } from '@open-gateway/ui';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import type { ApiDetail } from '@/hooks/use-apis';
import { useMediaQuery } from '@/hooks/use-media-query';
import { usePageFilterLabels } from '@/hooks/use-page-filter-labels';
import { usePermissions } from '@/hooks/use-permissions';
import {
  appliesTo,
  isNoSpec,
  isOffered,
  useEndpointGovernance,
  useUpdateEndpoints,
  type EndpointGovernance,
  type EndpointGovernanceInput,
  type EndpointGovernanceList,
  type GovernanceControl,
  type GovernedEndpoint,
  type UpdateEndpointsBody,
} from '@/lib/api/openapi';
import { toastApiError } from './api-error';
import { BulkValueSheet, type BulkValueControl } from './bulk-value-sheet';
import { EndpointGovernanceSheet } from './endpoint-governance-sheet';
import { MethodBadge } from './method-badge';

const PAGE_SIZE = 50;
/** The API refuses allow-list mode past this many indexed endpoints (contract §2 rule 8). */
const MAX_MANAGED_ENDPOINTS = 1000;
const VIEW_STORAGE_KEY = 'og:apis:endpoints-view';
const NO_ROWS: GovernedEndpoint[] = [];

type Translate = ReturnType<typeof useTranslations>;

/** What is governed on an endpoint, as short chips. Empty = inherits everything from the API. */
function governanceChips(
  g: EndpointGovernance | null,
  t: Translate,
): { label: string; tone: 'destructive' | 'secondary' }[] {
  if (!g) return [];
  const chips: { label: string; tone: 'destructive' | 'secondary' }[] = [];
  if (g.enabled === false) chips.push({ label: t('chips.blocked'), tone: 'destructive' });
  if (g.auth === 'public') chips.push({ label: t('chips.public'), tone: 'secondary' });
  if (g.rateLimit)
    chips.push({
      label: t('chips.rateLimit', { rate: g.rateLimit.rate, per: g.rateLimit.per }),
      tone: 'secondary',
    });
  if (g.cache)
    chips.push({ label: t('chips.cache', { seconds: g.cache.timeoutSeconds }), tone: 'secondary' });
  if (g.timeoutSeconds !== undefined)
    chips.push({ label: t('chips.timeout', { seconds: g.timeoutSeconds }), tone: 'secondary' });
  if (g.requestSizeLimitBytes !== undefined)
    chips.push({
      label: t('chips.sizeLimit', { bytes: g.requestSizeLimitBytes }),
      tone: 'secondary',
    });
  if (g.mock) chips.push({ label: t('chips.mock', { code: g.mock.code }), tone: 'secondary' });
  if (g.validateRequestSchema) chips.push({ label: t('chips.validate'), tone: 'secondary' });
  return chips;
}

function GovernanceChips({ governance }: { governance: EndpointGovernance | null }) {
  const t = useTranslations('openapi');
  const chips = governanceChips(governance, t);
  if (chips.length === 0)
    return <span className="text-muted-foreground text-sm">{t('chips.inherits')}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <Badge key={c.label} variant={c.tone} className="font-normal">
          {c.label}
        </Badge>
      ))}
    </div>
  );
}

function EndpointPath({ row }: { row: GovernedEndpoint }) {
  const t = useTranslations('openapi');
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <span dir="ltr" className="break-all font-mono text-xs">
          {row.path}
        </span>
        {row.deprecated && <Badge variant="outline">{t('table.deprecated')}</Badge>}
      </div>
      {row.summary && <p className="text-muted-foreground text-xs">{row.summary}</p>}
    </div>
  );
}

function TabSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function EndpointsTab({ api }: { api: ApiDetail }) {
  const { can } = usePermissions();
  return (
    <>
      {/* The watched URL applies with or without a stored spec: an API created by hand can watch one
          too (its first detected version is applied as version 1), so this sits above every state. */}
      <div className="mb-4 space-y-4">
        <SpecUpdateBanner apiId={api.id} />
        <SpecSourceCard apiId={api.id} canUpdate={can('api:update')} />
      </div>
      <EndpointsBody api={api} />
    </>
  );
}

function EndpointsBody({ api }: { api: ApiDetail }) {
  const t = useTranslations('openapi');
  const tCommon = useTranslations('common');
  const { data, isPending, isError, error, refetch } = useEndpointGovernance(api.id);
  const { can } = usePermissions();
  const [specOpen, setSpecOpen] = useState(false);

  if (isPending) return <TabSkeleton />;
  if (isError && isNoSpec(error)) {
    // No stored spec: a user who may update the API can attach one (expectedVersion 0 creates version 1).
    return (
      <>
        <StateCard
          icon={<FileX aria-hidden="true" />}
          title={t('noSpec.title')}
          message={t('noSpec.message')}
        >
          {can('api:update') && (
            <Button
              type="button"
              onClick={() => {
                setSpecOpen(true);
              }}
            >
              <FileUp className="h-4 w-4" aria-hidden="true" />
              {t('noSpec.upload')}
            </Button>
          )}
        </StateCard>
        <SpecUpdateSheet apiId={api.id} versionNo={0} open={specOpen} onOpenChange={setSpecOpen} />
      </>
    );
  }
  if (isError) {
    return (
      <StateCard
        role="alert"
        icon={<AlertTriangle className="text-destructive" aria-hidden="true" />}
        title={t('loadError')}
        message={error.message}
      >
        <Button type="button" onClick={() => void refetch()}>
          {tCommon('retry')}
        </Button>
      </StateCard>
    );
  }

  return (
    <>
      <EndpointsView
        api={api}
        list={data}
        canUpdate={can('api:update')}
        onUpdateSpec={() => {
          setSpecOpen(true);
        }}
      />
      <SpecUpdateSheet
        apiId={api.id}
        versionNo={data.versionNo}
        open={specOpen}
        onOpenChange={setSpecOpen}
      />
    </>
  );
}

/** Which endpoints a bulk action targets: the selected rows, or every endpoint carrying a tag. */
type BulkTarget = { keys: string[] } | { tag: string };

interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  /** Captured when the dialog opened: the action compare-and-sets against what the user saw. */
  revision: string;
  run: (revision: string) => Promise<unknown>;
}

function EndpointsView({
  api,
  list,
  canUpdate,
  onUpdateSpec,
}: {
  api: ApiDetail;
  list: EndpointGovernanceList;
  canUpdate: boolean;
  onUpdateSpec: () => void;
}) {
  const t = useTranslations('openapi');
  const tApis = useTranslations('apis');
  const tCommon = useTranslations('common');
  const filterLabels = usePageFilterLabels();
  const mutation = useUpdateEndpoints(api.id);
  const [viewMode, setViewMode] = useViewMode(VIEW_STORAGE_KEY);
  const isNarrow = useMediaQuery('(max-width: 639px)');
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('ALL');
  const [tagScope, setTagScope] = useState(false);
  const [page, setPage] = useState(1);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [editing, setEditing] = useState<GovernedEndpoint | null>(null);
  const [bulkValue, setBulkValue] = useState<{
    control: BulkValueControl;
    revision: string;
    target: BulkTarget;
    count: number;
  } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const apiWideCache = !!api.config?.cache;

  const tags = useMemo(
    () => [...new Set(list.endpoints.flatMap((e) => e.tags))].sort(),
    [list.endpoints],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return list.endpoints.filter(
      (e) =>
        (tag === 'ALL' || e.tags.includes(tag)) &&
        (q === '' ||
          [e.path, e.method, e.key, e.summary ?? ''].some((s) => s.toLowerCase().includes(q))),
    );
  }, [list.endpoints, search, tag]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  const resetView = () => {
    setPage(1);
    setRowSelection({});
  };

  /** One PATCH compare-and-set on `revision`; a stale one reloads the list and says why. */
  const patch = useCallback(
    async (
      body: Omit<UpdateEndpointsBody, 'expectedRevision'>,
      savedMessage: string,
      revision: string,
    ): Promise<boolean> => {
      try {
        const saved = await mutation.mutateAsync({ expectedRevision: revision, ...body });
        toastSyncOutcome(tApis, saved, savedMessage);
        return true;
      } catch (err) {
        toastApiError(t, err, 'governance.saveError');
        return false;
      }
    },
    [mutation, t, tApis],
  );

  // From the CURRENT rows: a key that left the list on a refetch is no longer selected.
  const selectedRows = list.endpoints.filter((e) => rowSelection[e.key]);
  const taggedRows = tag === 'ALL' ? [] : list.endpoints.filter((e) => e.tags.includes(tag));
  const useTag = tagScope && tag !== 'ALL';
  const targetRows = useTag ? taggedRows : selectedRows;
  const target: BulkTarget = useTag ? { tag } : { keys: selectedRows.map((r) => r.key) };
  const savedToast = t('bulk.savedToast', { count: targetRows.length });

  const bulk = async (
    body: { set?: EndpointGovernanceInput; clear?: GovernanceControl[] },
    revision = list.revision,
    to = target,
  ) => {
    if (await patch({ ...to, ...body }, savedToast, revision)) {
      setRowSelection({});
      return true;
    }
    return false;
  };

  const ask = (request: Omit<ConfirmRequest, 'revision'>) => {
    setConfirm({ ...request, revision: list.revision });
  };

  const columns = useMemo<ColumnDef<GovernedEndpoint>[]>(() => {
    const cols: ColumnDef<GovernedEndpoint>[] = [
      {
        accessorKey: 'method',
        header: t('table.method'),
        cell: ({ row }) => <MethodBadge method={row.original.method} />,
      },
      {
        accessorKey: 'path',
        header: t('table.path'),
        cell: ({ row }) => <EndpointPath row={row.original} />,
      },
      {
        accessorKey: 'tags',
        header: t('table.tags'),
        cell: ({ row }) =>
          row.original.tags.length ? (
            <div className="flex flex-wrap gap-1">
              {row.original.tags.map((tg) => (
                <Badge key={tg} variant="outline" className="font-normal">
                  {tg}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">{'—'}</span>
          ),
      },
      {
        id: 'governance',
        header: t('table.governance'),
        cell: ({ row }) => <GovernanceChips governance={row.original.governance} />,
      },
      {
        id: 'actions',
        cell: ({ row }) => (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t(canUpdate ? 'table.editEndpoint' : 'table.viewEndpoint', {
              endpoint: `${row.original.method} ${row.original.path}`,
            })}
            onClick={() => {
              setEditing(row.original);
            }}
          >
            {canUpdate ? (
              <Pencil className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
        ),
      },
    ];
    if (!canUpdate) return cols;
    return [
      {
        id: 'select',
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllRowsSelected() || (table.getIsSomeRowsSelected() && 'indeterminate')
            }
            onCheckedChange={(v) => {
              table.toggleAllRowsSelected(v === true);
            }}
            aria-label={t('table.selectPage')}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(v) => {
              row.toggleSelected(v === true);
            }}
            aria-label={t('table.selectRow', {
              endpoint: `${row.original.method} ${row.original.path}`,
            })}
          />
        ),
      },
      ...cols,
    ];
  }, [canUpdate, t]);

  const table = useReactTable({
    data: pageRows.length ? pageRows : NO_ROWS,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.key,
    enableRowSelection: canUpdate,
    state: { rowSelection },
    onRowSelectionChange: setRowSelection,
  });

  const offered = (c: GovernanceControl) => isOffered(list.capabilities, c);
  const allAccept = (c: GovernanceControl) => targetRows.every((r) => appliesTo(c, r.method));
  const restrictBlocked = list.endpointCount > MAX_MANAGED_ENDPOINTS;
  const cardsShown = viewMode === 'card' || isNarrow;
  const allPageSelected = pageRows.length > 0 && pageRows.every((r) => rowSelection[r.key]);

  return (
    <div className="space-y-4">
      {/* Spec summary + sync state */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">
              {t('summary.version', { version: list.versionNo, count: list.endpointCount })}
            </p>
            <p className="text-muted-foreground text-sm">
              {t('summary.format', {
                format: list.format.toUpperCase(),
                version: list.openapiVersion,
              })}
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1 text-sm">
              <span className="text-muted-foreground">{t('summary.gateway')}</span>
              <SyncStatusBadge
                apiId={api.id}
                syncStatus={list.syncStatus}
                syncError={list.syncError}
              />
            </div>
          </div>
          {canUpdate && (
            <Button type="button" variant="outline" onClick={onUpdateSpec}>
              <FileUp className="h-4 w-4" aria-hidden="true" />
              {t('summary.updateSpec')}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Allow-list mode: both directions confirmed, turning it off removes the hard boundary. */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="restrict-to-spec">{t('restrict.label')}</Label>
              <p className="text-muted-foreground text-sm">
                {list.restrictToSpec ? t('restrict.onHelp') : t('restrict.offHelp')}
              </p>
            </div>
            <Switch
              id="restrict-to-spec"
              checked={list.restrictToSpec}
              disabled={
                !canUpdate || mutation.isPending || (restrictBlocked && !list.restrictToSpec)
              }
              onCheckedChange={(v) => {
                ask(
                  v
                    ? {
                        title: t('restrict.confirmTitle'),
                        body: t('restrict.confirmBody', { count: list.endpointCount }),
                        confirmLabel: t('restrict.confirm'),
                        run: (rev) => patch({ restrictToSpec: true }, t('restrict.onToast'), rev),
                      }
                    : {
                        title: t('restrict.confirmOffTitle'),
                        body: t('restrict.confirmOffBody'),
                        confirmLabel: t('restrict.confirmOff'),
                        run: (rev) => patch({ restrictToSpec: false }, t('restrict.offToast'), rev),
                      },
                );
              }}
            />
          </div>
          <Notice>
            <p>{t('restrict.boundary')}</p>
            <p>{t('restrict.methods')}</p>
          </Notice>
          {restrictBlocked && (
            <p className="text-muted-foreground text-sm">
              {t('restrict.tooMany', { max: MAX_MANAGED_ENDPOINTS })}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Governance of endpoints that are no longer in the spec */}
      {list.orphans.length > 0 && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-0.5">
                <h3 className="text-sm font-medium">
                  {t('orphans.title', { count: list.orphans.length })}
                </h3>
                <p className="text-muted-foreground text-sm">{t('orphans.help')}</p>
              </div>
              {canUpdate && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    ask({
                      title: t('orphans.confirmTitle'),
                      body: t('orphans.confirmBody', { count: list.orphans.length }),
                      confirmLabel: t('orphans.remove'),
                      run: (rev) => patch({ dropOrphans: true }, t('orphans.removedToast'), rev),
                    });
                  }}
                >
                  {t('orphans.remove')}
                </Button>
              )}
            </div>
            <ul className="space-y-2">
              {list.orphans.map((o) => (
                <li
                  key={o.key}
                  className="flex flex-col gap-1 rounded-md border p-2 sm:flex-row sm:items-center sm:gap-3"
                >
                  <span dir="ltr" className="break-all font-mono text-xs">
                    {o.key}
                  </span>
                  <GovernanceChips governance={o.governance} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* Client-side filtering, so the search fires per keystroke (debounceMs 0); the clear action lives in the empty state. */}
        <PageFilter
          layout="inline"
          showReset={false}
          fields={[
            {
              type: 'search',
              key: 'q',
              label: t('filters.search'),
              placeholder: t('filters.search'),
              debounceMs: 0,
              className: 'w-full sm:w-64',
            },
            {
              type: 'select',
              key: 'tag',
              label: t('filters.tag'),
              allLabel: t('filters.allTags'),
              options: tags.map((tg) => ({ value: tg, label: tg })),
            },
          ]}
          values={{ q: search || undefined, tag: tag === 'ALL' ? undefined : tag }}
          onChange={(patch) => {
            if ('q' in patch) setSearch(typeof patch.q === 'string' ? patch.q : '');
            if ('tag' in patch) {
              setTag(typeof patch.tag === 'string' ? patch.tag : 'ALL');
              // A different tag is a different bulk target: the "whole tag" scope does not carry over.
              setTagScope(false);
            }
            resetView();
          }}
          onReset={() => {
            setSearch('');
            setTag('ALL');
            setTagScope(false);
            resetView();
          }}
          labels={filterLabels}
        />
        {canUpdate && cardsShown && pageRows.length > 0 && (
          <div className="flex min-h-11 items-center gap-2">
            <Checkbox
              id="select-page"
              checked={allPageSelected}
              onCheckedChange={(v) => {
                setRowSelection(
                  v === true ? Object.fromEntries(pageRows.map((r) => [r.key, true])) : {},
                );
              }}
            />
            <Label htmlFor="select-page">{t('table.selectPage')}</Label>
          </div>
        )}
        <div className="sm:ms-auto">
          <ViewModeToggle mode={viewMode} onChange={setViewMode} />
        </div>
      </div>

      {/* Bulk actions */}
      {canUpdate && (selectedRows.length > 0 || tag !== 'ALL') && (
        <div
          role="region"
          aria-label={t('bulk.region')}
          className="bg-muted/50 flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="space-y-2">
            {tag !== 'ALL' && (
              <div className="flex min-h-11 items-center gap-2">
                <Checkbox
                  id="bulk-tag-scope"
                  checked={tagScope}
                  onCheckedChange={(v) => {
                    setTagScope(v === true);
                  }}
                />
                <Label htmlFor="bulk-tag-scope">
                  {t('bulk.tagScope', { count: taggedRows.length, tag })}
                </Label>
              </div>
            )}
            <p className="text-sm" aria-live="polite">
              {t('bulk.selected', { count: targetRows.length })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {selectedRows.length > 0 && !useTag && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setRowSelection({});
                }}
              >
                {t('bulk.clearSelection')}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  disabled={targetRows.length === 0 || mutation.isPending}
                  loading={mutation.isPending}
                >
                  {t('bulk.actions')}
                  <ChevronDown className="h-4 w-4" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {offered('enabled') && (
                  <>
                    <DropdownMenuItem
                      onClick={() => {
                        const to = target;
                        ask({
                          title: t('bulk.confirmBlockTitle'),
                          body: t('bulk.confirmBlockBody', { count: targetRows.length }),
                          confirmLabel: t('bulk.block'),
                          run: (rev) => bulk({ set: { enabled: false } }, rev, to),
                        });
                      }}
                    >
                      {t('bulk.block')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void bulk({ clear: ['enabled'] })}>
                      {t('bulk.unblock')}
                    </DropdownMenuItem>
                  </>
                )}
                {offered('auth') && (
                  <>
                    <DropdownMenuItem
                      onClick={() => {
                        const to = target;
                        ask({
                          title: t('bulk.confirmPublicTitle'),
                          body: t('bulk.confirmPublicBody', { count: targetRows.length }),
                          confirmLabel: t('bulk.makePublic'),
                          run: (rev) => bulk({ set: { auth: 'public' } }, rev, to),
                        });
                      }}
                    >
                      {t('bulk.makePublic')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void bulk({ clear: ['auth'] })}>
                      {t('bulk.inheritAuth')}
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuSeparator />
                {(['rateLimit', 'timeoutSeconds', 'requestSizeLimitBytes', 'cache'] as const)
                  .filter((c) => offered(c))
                  .map((c) => {
                    const blocked = !allAccept(c) || (c === 'cache' && apiWideCache);
                    return (
                      <DropdownMenuItem
                        key={`set-${c}`}
                        disabled={blocked}
                        onClick={() => {
                          setBulkValue({
                            control: c,
                            revision: list.revision,
                            target,
                            count: targetRows.length,
                          });
                        }}
                      >
                        {t(`bulk.set.${c}`)}
                        {blocked && (
                          <span className="text-muted-foreground ms-1 text-xs">
                            {t(`bulk.notFor.${c}`)}
                          </span>
                        )}
                      </DropdownMenuItem>
                    );
                  })}
                <DropdownMenuSeparator />
                {(['rateLimit', 'timeoutSeconds', 'requestSizeLimitBytes', 'cache'] as const)
                  .filter((c) => offered(c))
                  .map((c) => (
                    <DropdownMenuItem key={`clear-${c}`} onClick={() => void bulk({ clear: [c] })}>
                      {t(`bulk.clear.${c}`)}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}

      <DataTable
        table={table}
        isLoading={false}
        isError={false}
        emptyMessage={list.endpoints.length ? t('empty.filtered') : t('empty.none')}
        emptyAction={
          list.endpoints.length ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSearch('');
                setTag('ALL');
                setTagScope(false);
                resetView();
              }}
            >
              {tCommon('clearFilters')}
            </Button>
          ) : undefined
        }
        viewMode={viewMode}
        renderCard={(row) => (
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  {canUpdate && (
                    <Checkbox
                      checked={!!rowSelection[row.key]}
                      onCheckedChange={(v) => {
                        setRowSelection((s) => ({ ...s, [row.key]: v === true }));
                      }}
                      aria-label={t('table.selectRow', { endpoint: `${row.method} ${row.path}` })}
                    />
                  )}
                  <MethodBadge method={row.method} />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="-me-2 -mt-2"
                  aria-label={t(canUpdate ? 'table.editEndpoint' : 'table.viewEndpoint', {
                    endpoint: `${row.method} ${row.path}`,
                  })}
                  onClick={() => {
                    setEditing(row);
                  }}
                >
                  {canUpdate ? (
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </Button>
              </div>
              <EndpointPath row={row} />
              <GovernanceChips governance={row.governance} />
            </CardContent>
          </Card>
        )}
      />

      {filtered.length > PAGE_SIZE && (
        <DataTablePagination
          page={page}
          totalPages={totalPages}
          totalCount={filtered.length}
          onPrevious={() => {
            setPage((p) => Math.max(1, p - 1));
            setRowSelection({});
          }}
          onNext={() => {
            setPage((p) => Math.min(totalPages, p + 1));
            setRowSelection({});
          }}
        />
      )}

      <EndpointGovernanceSheet
        apiId={api.id}
        endpoint={editing}
        list={list}
        apiWideCache={apiWideCache}
        readOnly={!canUpdate}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
      <BulkValueSheet
        control={bulkValue?.control ?? null}
        count={bulkValue?.count ?? 0}
        onOpenChange={(open) => {
          if (!open) setBulkValue(null);
        }}
        onApply={(set) =>
          bulkValue ? bulk({ set }, bulkValue.revision, bulkValue.target) : Promise.resolve(false)
        }
      />

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirm?.run(confirm.revision)}>
              {confirm?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
