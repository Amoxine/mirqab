'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AlertTriangle, ArrowLeft, Pencil, Play, SearchX, ShieldOff, Trash2, UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PagePermissionGate, PermissionGate } from '@/components/auth/permission-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/sonner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { InviteMemberSheet } from '@/components/tenants/invite-member-sheet';
import { RemoveMemberDialog } from '@/components/tenants/remove-member-dialog';
import { TenantFormSheet } from '@/components/tenants/tenant-form-sheet';
import { TenantStatusDialog } from '@/components/tenants/tenant-status-dialog';
import { TenantUsageCard } from '@/components/tenants/tenant-usage-card';
import { useTenant, useTenantMembers, useUpdateMemberRole, type Tenant, type TenantMember } from '@/hooks/use-tenants';
import { usePermissions } from '@/hooks/use-permissions';
import { ApiRequestError } from '@/lib/api-client';

/** Roles an admin can hand out from this page. `super_admin` is a system-wide bypass keyed only on
 * the role name (see keto.ts's relationForRole) — never offered here, so a row that already holds
 * it (only the seed admin) shows as read-only instead of a dropdown that could reassign it. */
const EDITABLE_ROLES = ['admin', 'operator', 'viewer'];

const tenantStatusColor = (status: string) =>
  status === 'ACTIVE' ? 'default' : status === 'SUSPENDED' ? 'destructive' : 'outline';

const isNotFound = (error: unknown) => error instanceof ApiRequestError && error.status === 404;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-9 w-64 max-w-full" />
        <Skeleton className="h-4 w-40" />
      </div>
      <Card>
        <CardContent className="grid gap-6 pt-6 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-48 max-w-full" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function StateCard({ icon, title, message, children }: { icon: ReactNode; title: string; message: string; children: ReactNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        {icon}
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="max-w-md break-words text-sm text-muted-foreground">{message}</p>
        <div className="flex flex-wrap justify-center gap-2">{children}</div>
      </CardContent>
    </Card>
  );
}

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
            toast.success(t('members.roleUpdatedToast', { email: member.email, role: t(`roles.${role}`) }));
          },
          (error: unknown) => {
            // The server refuses (400) demoting the tenant's last admin — its message names that.
            toast.error(error instanceof Error ? error.message : t('members.roleUpdateError'));
          },
        );
      }}
    >
      <SelectTrigger className="w-[130px]" aria-label={t('members.roleAriaLabel', { email: member.email })}>
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

function MembersCard({ tenantId }: { tenantId: string }) {
  const t = useTranslations('tenants');
  const tCommon = useTranslations('common');
  const { can } = usePermissions();
  const { data, isLoading, isError, error, refetch } = useTenantMembers(tenantId);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ userId: string; email: string } | null>(null);

  let body: ReactNode;
  if (isLoading) {
    body = Array.from({ length: 3 }).map((_, i) => (
      <TableRow key={i}>
        {Array.from({ length: 4 }).map((__, j) => (
          <TableCell key={j}>
            <Skeleton className="h-5 w-24" />
          </TableCell>
        ))}
      </TableRow>
    ));
  } else if (isError) {
    body = (
      <TableRow>
        <TableCell colSpan={4} className="h-24 text-center">
          <p className="text-sm text-destructive">{error.message}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => {
              void refetch();
            }}
          >
            {tCommon('retry')}
          </Button>
        </TableCell>
      </TableRow>
    );
  } else if (!data?.length) {
    body = (
      <TableRow>
        <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
          {t('members.empty')}
        </TableCell>
      </TableRow>
    );
  } else {
    body = data.map((member) => (
      <TableRow key={member.userId}>
        <TableCell>
          <p className="font-medium">{member.name}</p>
          <p className="text-xs text-muted-foreground">{member.email}</p>
        </TableCell>
        <TableCell>
          <MemberRoleCell tenantId={tenantId} member={member} />
        </TableCell>
        <TableCell>{new Date(member.createdAt).toLocaleDateString()}</TableCell>
        <TableCell>
          <PermissionGate permission="user:delete">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => {
                setRemoveTarget({ userId: member.userId, email: member.email });
              }}
            >
              <Trash2 className="h-4 w-4" />
              <span className="sr-only">{t('members.removeAriaLabel', { email: member.email })}</span>
            </Button>
          </PermissionGate>
        </TableCell>
      </TableRow>
    ));
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-lg">{t('members.title')}</CardTitle>
        <PermissionGate permission="user:create">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setInviteOpen(true);
            }}
          >
            <UserPlus className="me-2 h-4 w-4" />
            {t('members.invite')}
          </Button>
        </PermissionGate>
      </CardHeader>
      <CardContent>
        <div className="w-0 min-w-full rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('members.columnUser')}</TableHead>
                <TableHead>{t('fields.role')}</TableHead>
                <TableHead>{t('members.columnJoined')}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>{body}</TableBody>
          </Table>
        </div>
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

function TenantDetailView({ tenant }: { tenant: Tenant }) {
  const t = useTranslations('tenants');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const { can } = usePermissions();
  const [editOpen, setEditOpen] = useState(false);
  const [statusAction, setStatusAction] = useState<'suspend' | 'reactivate' | 'archive' | null>(null);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ms-3">
          <Link href="/tenants">
            <ArrowLeft className="me-2 h-4 w-4" />
            {t('detail.backToTenants')}
          </Link>
        </Button>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="break-words text-3xl font-bold tracking-tight">{tenant.name}</h1>
              <Badge variant={tenantStatusColor(tenant.status)}>{t(`status.${tenant.status}`)}</Badge>
              <Badge variant="outline">{t(`plan.${tenant.plan}`)}</Badge>
            </div>
            <p className="mt-1 font-mono text-sm text-muted-foreground">{'/'}{tenant.slug}</p>
          </div>
          {tenant.status !== 'ARCHIVED' && (
            <div className="flex flex-wrap gap-2">
              <PermissionGate permission="tenant:update">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEditOpen(true);
                  }}
                >
                  <Pencil className="me-2 h-4 w-4" />
                  {tCommon('edit')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setStatusAction(tenant.status === 'SUSPENDED' ? 'reactivate' : 'suspend');
                  }}
                >
                  {tenant.status === 'SUSPENDED' ? (
                    <Play className="me-2 h-4 w-4" />
                  ) : (
                    <ShieldOff className="me-2 h-4 w-4" />
                  )}
                  {tenant.status === 'SUSPENDED' ? t('actions.reactivate') : t('actions.suspend')}
                </Button>
              </PermissionGate>
              <PermissionGate permission="tenant:delete">
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    setStatusAction('archive');
                  }}
                >
                  <Trash2 className="me-2 h-4 w-4" />
                  {t('actions.archive')}
                </Button>
              </PermissionGate>
            </div>
          )}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('detail.overview')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-6 sm:grid-cols-2">
            <Field label={tCommon('name')}>{tenant.name}</Field>
            <Field label={t('fields.slug')}>
              <span className="font-mono">{tenant.slug}</span>
            </Field>
            <Field label={t('fields.plan')}>{t(`plan.${tenant.plan}`)}</Field>
            <Field label={tCommon('status')}>
              <Badge variant={tenantStatusColor(tenant.status)}>{t(`status.${tenant.status}`)}</Badge>
            </Field>
            <Field label={tCommon('createdAt')}>{new Date(tenant.createdAt).toLocaleString()}</Field>
            <Field label={t('fields.updated')}>{new Date(tenant.updatedAt).toLocaleString()}</Field>
          </dl>
        </CardContent>
      </Card>

      <PermissionGate permission="user:read">
        <MembersCard tenantId={tenant.id} />
      </PermissionGate>

      <TenantUsageCard tenantId={tenant.id} tenantName={tenant.name} canManage={can('tenant:update')} />

      <TenantFormSheet mode="edit" tenant={tenant} open={editOpen} onOpenChange={setEditOpen} />
      <TenantStatusDialog
        tenant={statusAction ? { id: tenant.id, name: tenant.name } : null}
        action={statusAction ?? 'suspend'}
        onClose={() => {
          setStatusAction(null);
        }}
        onArchived={() => {
          router.push('/tenants');
        }}
      />
    </div>
  );
}

function TenantDetailPage() {
  const t = useTranslations('tenants');
  const tCommon = useTranslations('common');
  const { id } = useParams<{ id: string }>();
  const { data, isPending, isError, error, refetch } = useTenant(id);

  if (isPending) return <DetailSkeleton />;

  if (isError) {
    if (isNotFound(error)) {
      return (
        <StateCard
          icon={<SearchX className="h-10 w-10 text-muted-foreground" />}
          title={t('detail.notFoundTitle')}
          message={t('detail.notFoundMessage')}
        >
          <Button asChild>
            <Link href="/tenants">{t('detail.backToTenants')}</Link>
          </Button>
        </StateCard>
      );
    }
    return (
      <StateCard
        icon={<AlertTriangle className="h-10 w-10 text-destructive" />}
        title={t('detail.loadErrorTitle')}
        message={error.message}
      >
        <Button
          type="button"
          onClick={() => {
            void refetch();
          }}
        >
          {tCommon('retry')}
        </Button>
        <Button asChild variant="outline">
          <Link href="/tenants">{t('detail.backToTenants')}</Link>
        </Button>
      </StateCard>
    );
  }

  return <TenantDetailView tenant={data} />;
}

export default function TenantDetailPageGated() {
  return (
    <PagePermissionGate permission="tenant:read">
      <TenantDetailPage />
    </PagePermissionGate>
  );
}
