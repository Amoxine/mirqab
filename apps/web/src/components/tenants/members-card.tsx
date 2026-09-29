'use client';

import { useMemo, useState } from 'react';
import { getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { Check, Copy, Trash2, UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PermissionGate } from '@/components/auth/permission-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { DataTable, DataTablePagination } from '@/components/shared/data-table';
import { FormattedDate } from '@/components/shared/formatted';
import { InviteMemberSheet } from '@/components/tenants/invite-member-sheet';
import { RemoveMemberDialog } from '@/components/tenants/remove-member-dialog';
import { useTenantMembers, useUpdateMemberRole, type TenantMember } from '@/hooks/use-tenants';
import { PageFilter } from '@open-gateway/ui';
import { usePageFilterLabels } from '@/hooks/use-page-filter-labels';
import { usePermissions } from '@/hooks/use-permissions';

/** Roles an admin can hand out from this page. `super_admin` is a system-wide bypass keyed only on
 * the role name (see keto.ts's relationForRole) — never offered here, so a row that already holds
 * it (only the seed admin) shows as read-only instead of a dropdown that could reassign it. */
const EDITABLE_ROLES = ['admin', 'operator', 'viewer'];

const NO_MEMBERS: TenantMember[] = [];
const PAGE_SIZE = 20;
// ponytail: the repo has no debounce helper; a timer in an effect is all a search box needs.
const SEARCH_DEBOUNCE_MS = 250;

function MemberRoleCell({ tenantId, member }: { tenantId: string; member: TenantMember }) {
  const t = useTranslations('tenants');
  const { can } = usePermissions();
  const updateRole = useUpdateMemberRole(tenantId);
  // ponytail: a plain lookup, not t.has() — this next-intl version's client typings don't expose it.
  const roleLabels: Record<string, string> = {
    admin: t('roles.admin'),
    operator: t('roles.operator'),
    viewer: t('roles.viewer'),
    super_admin: t('roles.super_admin'),
  };

  if (!can('user:update') || !EDITABLE_ROLES.includes(member.role)) {
    return (
      <Badge variant="outline" className="capitalize">
        {roleLabels[member.role] ?? member.role}
      </Badge>
    );
  }

  return (
    <Select
      value={member.role}
      disabled={updateRole.isPending}
      onValueChange={(role) => {
        void updateRole.mutateAsync({ userId: member.userId, role }).then(
          () => {
            toast.success(
              t('members.roleUpdatedToast', { email: member.email, role: t(`roles.${role}`) }),
            );
          },
          (error: unknown) => {
            // The server refuses (400) demoting the tenant's last admin — its message names that.
            toast.error(error instanceof Error ? error.message : t('members.roleUpdateError'));
          },
        );
      }}
    >
      <SelectTrigger
        className="w-[130px]"
        aria-label={t('members.roleAriaLabel', { email: member.email })}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="admin">{t('roles.admin')}</SelectItem>
        <SelectItem value="operator">{t('roles.operator')}</SelectItem>
        <SelectItem value="viewer">{t('roles.viewer')}</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** Pending rows (invited, never yet claimed — V1-USR-01 Option F) get copy-able instructions instead
 * of a status label alone: this app never sends that invite email itself, so the admin has to relay
 * it, and the exact wording matters (never implies an email went out). */
function PendingInstructions({ email }: { email: string }) {
  const t = useTranslations('tenants');
  const [copied, setCopied] = useState(false);
  const text = t('members.pendingInstructionsText', { email });

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      toast.error(t('members.pendingCopyFailed'));
    }
  };

  return (
    <div className="mt-1 flex items-start gap-1.5">
      <p className="text-muted-foreground text-xs">{text}</p>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-5 w-5 shrink-0"
        aria-label={t('members.pendingCopyAriaLabel')}
        onClick={() => {
          void handleCopy();
        }}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}

export function MembersCard({ tenantId }: { tenantId: string }) {
  const t = useTranslations('tenants');
  const { can } = usePermissions();
  const filterLabels = usePageFilterLabels();
  const [page, setPage] = useState(1);
  // What the query uses: the search box (PageFilter) reports it one debounce after the last keystroke.
  const [searchTerm, setSearchTerm] = useState('');
  const { data, isLoading, isError, error, refetch } = useTenantMembers(tenantId, {
    page,
    pageSize: PAGE_SIZE,
    q: searchTerm,
  });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ userId: string; email: string } | null>(null);

  const columns = useMemo<ColumnDef<TenantMember>[]>(
    () => [
      {
        id: 'user',
        header: t('members.columnUser'),
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="font-medium">{row.original.name}</p>
              {row.original.pending && <Badge variant="outline">{t('members.pendingBadge')}</Badge>}
            </div>
            <p className="text-muted-foreground break-all text-xs">
              <span dir="ltr">{row.original.email}</span>
            </p>
            {row.original.pending && <PendingInstructions email={row.original.email} />}
          </div>
        ),
      },
      {
        id: 'role',
        header: t('fields.role'),
        cell: ({ row }) => <MemberRoleCell tenantId={tenantId} member={row.original} />,
      },
      {
        accessorKey: 'createdAt',
        header: t('members.columnJoined'),
        cell: ({ row }) => <FormattedDate value={row.original.createdAt} />,
      },
      {
        id: 'actions',
        cell: ({ row }) => (
          <PermissionGate permission="user:delete">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('members.removeAriaLabel', { email: row.original.email })}
              onClick={() => {
                setRemoveTarget({ userId: row.original.userId, email: row.original.email });
              }}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </PermissionGate>
        ),
      },
    ],
    [t, tenantId],
  );
  const table = useReactTable({
    data: data?.data ?? NO_MEMBERS,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-lg">{t('members.title')}</CardTitle>
        <PermissionGate permission="user:create">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setInviteOpen(true);
            }}
          >
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            {t('members.invite')}
          </Button>
        </PermissionGate>
      </CardHeader>
      <CardContent className="space-y-4">
        <PageFilter
          layout="inline"
          showReset={false}
          fields={[
            {
              type: 'search',
              key: 'q',
              label: t('members.searchAriaLabel'),
              placeholder: t('members.searchPlaceholder'),
              debounceMs: SEARCH_DEBOUNCE_MS,
              className: 'w-full sm:w-72',
            },
          ]}
          values={{ q: searchTerm }}
          // Fires once per pause in typing, so the page resets after the debounce, not per key.
          onChange={(patch) => {
            setSearchTerm(typeof patch.q === 'string' ? patch.q : '');
            setPage(1);
          }}
          onReset={() => {
            setSearchTerm('');
            setPage(1);
          }}
          labels={filterLabels}
        />
        <DataTable
          table={table}
          isLoading={isLoading}
          isError={isError}
          error={error}
          onRetry={() => void refetch()}
          emptyMessage={searchTerm ? t('members.noSearchResults') : t('members.empty')}
          skeletonRows={3}
        />
        <DataTablePagination
          page={page}
          totalPages={data?.meta.totalPages ?? 1}
          totalCount={data?.meta.totalCount}
          onPrevious={() => {
            setPage((p) => Math.max(1, p - 1));
          }}
          onNext={() => {
            setPage((p) => p + 1);
          }}
        />
      </CardContent>
      {can('user:create') && (
        <InviteMemberSheet tenantId={tenantId} open={inviteOpen} onOpenChange={setInviteOpen} />
      )}
      <RemoveMemberDialog
        tenantId={tenantId}
        member={removeTarget}
        onClose={() => {
          setRemoveTarget(null);
        }}
      />
    </Card>
  );
}
