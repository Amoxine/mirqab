'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocaleSwitcher } from '@/components/layout/locale-switcher';
import { kratos } from '@/lib/kratos-client';
import { usePortalMe } from '@/hooks/use-portal';

async function signOut(): Promise<void> {
  const flow = await kratos.createBrowserLogoutFlow();
  window.location.href = flow.logout_url;
}

/** The portal's own header — no dashboard Sidebar, no RBAC, a developer identity instead of a
 * tenant-admin one. Shown on every `/portal/*` page including the signed-out auth pages, so it
 * never itself assumes a session (`usePortalMe`'s `enabled` only reflects whether we're ON an auth
 * page, where checking would just bounce straight back into a redirect loop with the login page). */
export function PortalHeader() {
  const t = useTranslations('portal');
  const pathname = usePathname();
  const isAuthPage = pathname.startsWith('/portal/auth');
  const { data: me } = usePortalMe(!isAuthPage);

  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/portal" className="text-lg font-bold tracking-tight">
          {t('brand')}
        </Link>
        {!isAuthPage && (
          <nav className="hidden items-center gap-4 text-sm font-medium sm:flex">
            <Link href="/portal" className="text-muted-foreground hover:text-foreground">
              {t('nav.catalog')}
            </Link>
            <Link href="/portal/applications" className="text-muted-foreground hover:text-foreground">
              {t('nav.applications')}
            </Link>
          </nav>
        )}
        <div className="flex items-center gap-2">
          <LocaleSwitcher />
          {!isAuthPage && me && (
            <>
              <span className="hidden text-sm text-muted-foreground sm:inline">{me.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void signOut();
                }}
              >
                <LogOut className="me-2 h-4 w-4" />
                {t('nav.signOut')}
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
