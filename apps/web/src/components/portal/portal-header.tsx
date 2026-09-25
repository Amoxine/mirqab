'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocaleSwitcher } from '@/components/layout/locale-switcher';
import { kratos } from '@/lib/kratos-client';
import { usePortalMe } from '@/hooks/use-portal';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/portal', labelKey: 'nav.catalog' },
  { href: '/portal/applications', labelKey: 'nav.applications' },
] as const;

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
      {/* Wraps to two rows below `sm`: the nav used to be hidden there with no replacement, leaving
          phone users no way to reach My Applications. */}
      <div className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center justify-between gap-x-4 px-4">
        <Link href="/portal" className="rounded-sm py-4 text-lg font-bold tracking-tight">
          {t('brand')}
        </Link>
        {!isAuthPage && (
          <nav
            aria-label={t('nav.ariaLabel')}
            className="order-last -mx-2 flex w-full items-center gap-1 overflow-x-auto pb-2 text-sm font-medium sm:order-none sm:mx-0 sm:w-auto sm:pb-0"
          >
            {NAV.map((item) => {
              // Catalog also owns the product docs pages under /portal/products.
              const active =
                item.href === '/portal'
                  ? pathname === '/portal' || pathname.startsWith('/portal/products')
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'inline-flex min-h-10 items-center whitespace-nowrap rounded-md px-3 transition-colors duration-200 pointer-coarse:min-h-11',
                    active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {t(item.labelKey)}
                </Link>
              );
            })}
          </nav>
        )}
        <div className="flex items-center gap-2">
          <LocaleSwitcher />
          {!isAuthPage && me && (
            <>
              <span className="hidden max-w-40 truncate text-sm text-muted-foreground md:inline">{me.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                // The label is visually hidden on phones; keep the name for screen readers there.
                aria-label={t('nav.signOut')}
                onClick={() => {
                  void signOut();
                }}
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">{t('nav.signOut')}</span>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
