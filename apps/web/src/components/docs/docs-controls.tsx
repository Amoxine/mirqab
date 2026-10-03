'use client';

import type { ReactNode } from 'react';
import { PanelLeft, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { buttonVariants } from 'fumadocs-ui/components/ui/button';
import { useSearchContext } from 'fumadocs-ui/contexts/search';
import { useSidebar } from 'fumadocs-ui/contexts/sidebar';
import { cn } from 'fumadocs-ui/utils/cn';

/*
 * Fumadocs' own versions of these buttons hardcode English `aria-label`s ("Open Sidebar", "Collapse
 * Sidebar", "Open Search") that its i18n table cannot reach, and one toggle names both states "Open".
 * These are the same buttons with names from the app's messages.
 */

export const MOBILE_SIDEBAR_ID = 'nd-sidebar-mobile';

/** Opens and closes the docs menu drawer below `md`. Its name and `aria-expanded` follow the state. */
export function DocsSidebarTrigger({ className, children }: { className?: string; children: ReactNode }) {
  const t = useTranslations('docs.shell');
  const { open, setOpen } = useSidebar();
  return (
    <button
      type="button"
      className={cn(buttonVariants({ color: 'ghost', size: 'icon-sm', className: 'p-2' }), className)}
      aria-label={open ? t('closeMenu') : t('openMenu')}
      aria-expanded={open}
      aria-controls={MOBILE_SIDEBAR_ID}
      onClick={() => {
        setOpen((previous) => !previous);
      }}
    >
      {children}
    </button>
  );
}

/** Collapses the desktop sidebar to the edge and brings it back. */
export function DocsCollapseTrigger({ className }: { className?: string }) {
  const t = useTranslations('docs.shell');
  const { collapsed, setCollapsed } = useSidebar();
  return (
    <button
      type="button"
      className={cn(buttonVariants({ color: 'ghost', size: 'icon-sm' }), className)}
      aria-label={collapsed ? t('expandSidebar') : t('collapseSidebar')}
      aria-expanded={!collapsed}
      onClick={() => {
        setCollapsed((previous) => !previous);
      }}
    >
      <PanelLeft aria-hidden="true" />
    </button>
  );
}

/** The magnifier that opens the search dialog (the wide search box of the sidebar is Fumadocs' own, named by its i18n). */
export function DocsSearchToggle({ className }: { className?: string }) {
  const t = useTranslations('docs.shell');
  const { enabled, setOpenSearch } = useSearchContext();
  if (!enabled) return null;
  return (
    <button
      type="button"
      className={cn(buttonVariants({ color: 'ghost', size: 'icon-sm' }), className)}
      aria-label={t('openSearch')}
      onClick={() => {
        setOpenSearch(true);
      }}
    >
      <Search aria-hidden="true" />
    </button>
  );
}

/** Shown while the desktop sidebar is collapsed: how to bring it back, and search. */
export function DocsCollapsedControls() {
  const { collapsed } = useSidebar();
  // Not merely transparent while the sidebar is open: invisible buttons would still be a tab stop and be read out.
  if (!collapsed) return null;
  return (
    <div
      className="bg-fd-muted text-fd-muted-foreground fixed z-10 flex rounded-xl border p-0.5 shadow-lg max-md:hidden xl:start-4 max-xl:end-4"
      style={{ top: 'calc(var(--fd-banner-height) + var(--fd-tocnav-height) + var(--spacing) * 4)' }}
    >
      <DocsCollapseTrigger className="rounded-lg" />
      <DocsSearchToggle className="rounded-lg" />
    </div>
  );
}
