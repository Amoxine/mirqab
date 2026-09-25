'use client';

import { Building2, Check, ChevronsUpDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/hooks/use-auth';
import { getActiveTenantId } from '@/lib/active-tenant';
import { switchTenant } from '@/lib/switch-tenant';
import { cn } from '@/lib/utils';

/**
 * The active tenant, as the context for every page below it — so it lives at the top of the
 * sidebar (and of the mobile nav sheet), not in the top bar (guidelines §8). A dropdown only when
 * the user belongs to more than one tenant; otherwise just the name.
 */
export function TenantSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { user } = useAuth();
  const t = useTranslations('dashboard.header');
  const queryClient = useQueryClient();
  const activeId = getActiveTenantId();
  // `tenantName` is the user's *default* tenant; after a switch the active one is the header's.
  const name =
    user?.tenants.find((m) => m.tenantId === activeId)?.name ?? user?.tenantName ?? t('noTenantSelected');

  const label = (
    <span className="flex min-w-0 flex-1 flex-col text-start">
      <span className="text-xs text-muted-foreground">{t('tenantLabel')}</span>
      <span className="truncate text-sm font-medium">{name}</span>
    </span>
  );

  if (!user || user.tenants.length <= 1) {
    return collapsed ? null : (
      <div className="flex min-h-11 items-center gap-2 rounded-md px-2 py-1.5" title={name}>
        <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        {label}
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn('h-auto min-h-11 w-full gap-2 px-2 py-1.5', collapsed && 'justify-center px-0')}
          title={name}
          aria-label={collapsed ? t('switchTenantCurrent', { name }) : undefined}
        >
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {!collapsed && (
            <>
              {label}
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{t('switchTenant')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {user.tenants.map((membership) => {
          const current = membership.tenantId === activeId;
          return (
            <DropdownMenuItem
              key={membership.tenantId}
              disabled={current}
              onClick={() => {
                void switchTenant(queryClient, membership.tenantId);
              }}
            >
              <Check className={cn('h-4 w-4', !current && 'invisible')} aria-hidden="true" />
              <span className="truncate">{membership.name}</span>
              <span className="ms-auto text-xs text-muted-foreground">{membership.role}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
