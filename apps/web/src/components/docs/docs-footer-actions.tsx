'use client';

import { LocaleSwitcher } from '@/components/layout/locale-switcher';
import { ThemeSwitcher } from '@/components/layout/theme-switcher';

/**
 * The app's own appearance (theme + brand colour) and language controls, in place of fumadocs' theme
 * toggle: at the foot of the docs sidebar (in the drawer's header on small screens). Same cookies and
 * providers as the dashboard, so a choice made here applies everywhere.
 */
export function DocsFooterActions() {
  return (
    <div className="ms-auto flex items-center gap-2">
      <ThemeSwitcher />
      <LocaleSwitcher />
    </div>
  );
}
