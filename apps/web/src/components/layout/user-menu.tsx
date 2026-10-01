'use client';

import Link from 'next/link';
import { ChevronsUpDown, LogOut, Settings } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/sonner';
import { useAuth } from '@/hooks/use-auth';

/**
 * Logging out has to end BOTH sessions (the dashboard's own cookies and Kratos's), so it goes
 * through `/oauth2/session-logout` rather than a plain API call — see that route for why.
 */
async function logout(): Promise<void> {
  const res = await fetch('/oauth2/session-logout', { method: 'POST', credentials: 'include' });
  const { kratosLogoutUrl } = (await res.json()) as { kratosLogoutUrl: string | null };
  window.location.href = kratosLogoutUrl ?? '/auth/login';
}

interface UserMenuProps {
  /** `avatar`: the round button of the small-screen header. `sidebar`: the sidebar's footer row. */
  variant?: 'avatar' | 'sidebar';
  /** Sidebar only: the icon rail shows the avatar alone. */
  collapsed?: boolean;
  /** Sidebar only: which way the menu opens when collapsed (physical, so RTL passes `left`). */
  side?: 'left' | 'right';
}

export function UserMenu({ variant = 'avatar', collapsed = false, side = 'right' }: UserMenuProps) {
  const { user } = useAuth();
  const t = useTranslations('dashboard.header');
  // An empty name (not a missing one) falls back to the email, hence `||`.
  const initials =
    (user ? user.name || user.email : '')
      .split(/\s+/)
      .map((part) => part[0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'U';

  const avatar = (size: string) => (
    <Avatar className={size}>
      <AvatarFallback className="bg-secondary text-secondary-foreground text-xs font-semibold">{initials}</AvatarFallback>
    </Avatar>
  );
  const row = variant === 'sidebar' && !collapsed;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          aria-label={row ? undefined : t('userMenu')}
          className={cn(
            'rounded-full p-0',
            row ? 'h-auto w-full justify-start gap-3 px-2 py-2 text-start' : 'size-11',
          )}
        >
          {avatar(row ? 'size-9' : 'size-11')}
          {row && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium leading-tight">{user?.name}</span>
                <span dir="ltr" className="text-muted-foreground block truncate text-xs leading-tight">
                  {user?.email}
                </span>
              </span>
              <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-56"
        side={variant === 'sidebar' ? (collapsed ? side : 'top') : 'bottom'}
        align="end"
      >
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium leading-none">{user?.name}</p>
            <p className="text-muted-foreground truncate text-xs leading-none">
              <span dir="ltr">{user?.email}</span>
            </p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/auth/settings" className="flex w-full items-center gap-2">
            <Settings className="h-4 w-4" aria-hidden="true" />
            <span>{t('accountSettings')}</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-2"
          onSelect={() => {
            logout().catch(() => toast.error(t('logoutError')));
          }}
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          <span>{t('logOut')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
