'use client';

import { BookOpen } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Breadcrumb } from '@/components/layout/breadcrumb';
import { LocaleSwitcher } from '@/components/layout/locale-switcher';
import { MobileNav } from '@/components/layout/mobile-nav';
import { NotificationsBell } from '@/components/layout/notifications-bell';
import { ThemeSwitcher } from '@/components/layout/theme-switcher';
import { UserMenu } from '@/components/layout/user-menu';
import { Button } from '@/components/ui/button';

export function Header() {
  const t = useTranslations('dashboard.header');

  return (
    <header className="sticky top-0 z-40 flex h-16 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/85 sm:gap-3 md:px-6 lg:h-[4.5rem] lg:border-b-0 lg:ps-2 lg:pe-7">
      <MobileNav />

      {/* Phones: the page title sits right below, and the header's controls need the width. */}
      <div className="min-w-0 flex-1 overflow-hidden max-sm:invisible">
        <Breadcrumb />
      </div>

      {/* The controls are 238px wide without the docs link and need `gap-1.5` to sit inside a 320px
          phone; the docs link itself moves into the mobile nav sheet below `sm`. */}
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2 md:gap-2.5">
        <Button asChild variant="ghost" size="icon" className="bg-foreground/[0.06] hover:bg-foreground/[0.1] size-11 rounded-full max-sm:hidden">
          <Link href="/docs" aria-label={t('docs')} title={t('docs')}>
            <BookOpen className="h-4 w-4" aria-hidden="true" />
          </Link>
        </Button>
        <NotificationsBell />
        <ThemeSwitcher />
        <LocaleSwitcher />
        {/* lg+ keeps the user menu in the sidebar footer; below that the sidebar is a sheet. */}
        <div className="lg:hidden">
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
