'use client';

import type { ReactNode } from 'react';
import { ShieldOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions } from '@/hooks/use-permissions';

interface PermissionGateProps {
  /** Permission name in `resource:action` form, e.g. `api:create`. */
  permission: string;
  /** Rendered instead of `children` when the permission is missing (and while it is still loading). */
  fallback?: ReactNode;
  children: ReactNode;
}

/** Renders `children` only when the current user holds `permission`. */
export function PermissionGate({ permission, fallback = null, children }: PermissionGateProps) {
  const { can } = usePermissions();
  return <>{can(permission) ? children : fallback}</>;
}

/**
 * Page-level gate: a skeleton while permissions load, a no-access state when `permission` is missing, else `children`.
 * `children` are only mounted when allowed, so their data queries never fire for a user who may not read the page.
 */
export function PagePermissionGate({
  permission,
  children,
}: {
  /** One permission, or a list that must ALL be held; the no-access state names the first one missing. */
  permission: string | readonly string[];
  children: ReactNode;
}) {
  const t = useTranslations('auth');
  const { can, isLoading } = usePermissions();

  if (isLoading) return <Skeleton className="h-64 w-full" aria-busy="true" />;
  const missing = [permission].flat().find((p) => !can(p));
  if (missing !== undefined) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <ShieldOff className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-lg font-semibold">{t('permissionGate.noAccessTitle')}</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {t.rich('permissionGate.noAccessDescription', {
              permission: missing,
              code: (chunks) => <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{chunks}</code>,
            })}
          </p>
        </CardContent>
      </Card>
    );
  }
  return <>{children}</>;
}
