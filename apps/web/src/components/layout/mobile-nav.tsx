'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Menu } from 'lucide-react';
import { navLinkClass, useNavItems } from '@/components/layout/sidebar';
import { TenantSwitcher } from '@/components/layout/tenant-switcher';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { RTL_LOCALES } from '@/i18n/locales';

/** Navigation below `lg`, where the sidebar is hidden: a sheet with the same permission-gated entries,
 * opening from the visual "start" edge — `Sheet` only knows the physical `left`/`right` sides, so
 * that's picked here rather than a Tailwind class. */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const items = useNavItems();
  const t = useTranslations('nav');
  const tMobileNav = useTranslations('dashboard');
  const locale = useLocale();
  const isRtl = (RTL_LOCALES as readonly string[]).includes(locale);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="shrink-0 lg:hidden">
          <Menu className="h-5 w-5" aria-hidden="true" />
          <span className="sr-only">{tMobileNav('mobileNav.openMenu')}</span>
        </Button>
      </SheetTrigger>
      <SheetContent side={isRtl ? 'right' : 'left'} className="w-64 max-w-[80vw] p-4 lg:hidden">
        <SheetHeader>
          <SheetTitle>{t('brand')}</SheetTitle>
          <SheetDescription className="sr-only">{tMobileNav('mobileNav.description')}</SheetDescription>
        </SheetHeader>
        {/* Same order as the desktop sidebar: tenant context first, then the pages under it. */}
        <div className="-mx-2 border-b pb-2">
          <TenantSwitcher />
        </div>
        <nav className="flex flex-col gap-1" aria-label={tMobileNav('mobileNav.description')}>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={navLinkClass(item.active)}
                aria-current={item.active ? 'page' : undefined}
                onClick={() => {
                  setOpen(false);
                }}
              >
                <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
