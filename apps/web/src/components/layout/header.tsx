'use client';

import { LogOut, Settings } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Breadcrumb } from '@/components/layout/breadcrumb';
import { LocaleSwitcher } from '@/components/layout/locale-switcher';
import { MobileNav } from '@/components/layout/mobile-nav';
import { ThemeSwitcher } from '@/components/layout/theme-switcher';
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
    <header className="sticky top-0 z-40 flex h-16 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:gap-4 md:px-6">
      <MobileNav />

      <div className="min-w-0 flex-1 overflow-hidden">
        <Breadcrumb />
      </div>

      <div className="flex shrink-0 items-center gap-2 md:gap-4">
        <ThemeSwitcher />
        <LocaleSwitcher />

        {/* User Menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="relative rounded-full" aria-label={t('userMenu')}>
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
                <p className="truncate text-xs leading-none text-muted-foreground">
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
            <DropdownMenuItem asChild>
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2"
                onClick={handleLogout}
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                <span>{t('logOut')}</span>
              </button>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
