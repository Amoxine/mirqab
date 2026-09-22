'use client';

import { ChevronsUpDown, LogOut, Settings } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Breadcrumb } from '@/components/layout/breadcrumb';
import { LocaleSwitcher } from '@/components/layout/locale-switcher';
import { MobileNav } from '@/components/layout/mobile-nav';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useAuth } from '@/hooks/use-auth';
import { getActiveTenantId, setActiveTenantId } from '@/lib/active-tenant';
import { toast } from '@/components/ui/sonner';

/**
 * Logging out has to end BOTH sessions (the dashboard's own cookies and Kratos's), so it goes
 * through `/oauth2/session-logout` rather than a plain API call — see that route for why.
 */
async function logout(): Promise<void> {
  const res = await fetch('/oauth2/session-logout', { method: 'POST', credentials: 'include' });
  const { kratosLogoutUrl } = (await res.json()) as { kratosLogoutUrl: string | null };
  window.location.href = kratosLogoutUrl ?? '/auth/login';
}

/**
 * Switching tenants is a pure client-side choice (see `lib/active-tenant.ts`) — nothing on the
 * server to update, just a different `X-Tenant-ID` on the next request. A full reload is the
 * simplest way to refetch every tenant-scoped query (apis/keys/analytics/audit-logs/auth.me all
 * depend on which tenant is active) without hand-picking which query keys to invalidate.
 */
function switchTenant(tenantId: string): void {
  setActiveTenantId(tenantId);
  window.location.reload();
}

export function Header() {
  const { user } = useAuth();
  const t = useTranslations('dashboard.header');

  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      toast.error(t('logoutError'));
    }
  };

  const initials = user
    ? (user.name || user.email)
        .split(/\s+/)
        .map((part) => part[0] ?? '')
        .join('')
        .slice(0, 2)
        .toUpperCase() || 'U'
    : 'U';

  return (
    <header className="sticky top-0 z-40 flex h-16 items-center gap-4 border-b bg-background px-4 md:px-6">
      <MobileNav />

      <div className="min-w-0 flex-1 overflow-hidden">
        <Breadcrumb />
      </div>

      <div className="flex shrink-0 items-center gap-2 md:gap-4">
        <LocaleSwitcher />

        {/* Current tenant, switchable when the user belongs to more than one. */}
        {user && user.tenants.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="max-w-36 gap-1 truncate text-xs sm:max-w-40 sm:text-sm md:max-w-64"
                title={user.tenantName ?? undefined}
              >
                <span className="truncate">{user.tenantName ?? t('noTenantSelected')}</span>
                <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>{t('switchTenant')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {user.tenants.map((membership) => (
                <DropdownMenuItem
                  key={membership.tenantId}
                  disabled={membership.tenantId === getActiveTenantId()}
                  onClick={() => {
                    switchTenant(membership.tenantId);
                  }}
                >
                  <span className="truncate">{membership.name}</span>
                  <span className="ms-auto text-xs text-muted-foreground">{membership.role}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div
            title={user?.tenantName ?? undefined}
            className="max-w-36 truncate rounded-md border bg-muted px-2 py-1.5 text-xs text-muted-foreground sm:max-w-40 sm:text-sm md:max-w-64 md:px-3"
          >
            {user?.tenantName ?? t('noTenantSelected')}
          </div>
        )}

        {/* User Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="relative h-8 w-8 rounded-full">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                  {initials}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-sm font-medium leading-none">
                  {user?.name}
                </p>
                <p className="text-xs leading-none text-muted-foreground">
                  {user?.email}
                </p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/auth/settings" className="flex w-full items-center gap-2">
                <Settings className="h-4 w-4" />
                <span>{t('accountSettings')}</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2"
                onClick={handleLogout}
              >
                <LogOut className="h-4 w-4" />
                <span>{t('logOut')}</span>
              </button>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
