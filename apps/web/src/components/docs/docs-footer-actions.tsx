'use client';

import { LocaleSwitcher } from '@/components/layout/locale-switcher';
import { ThemeSwitcher } from '@/components/layout/theme-switcher';

/**
 * The docs' navbar shares the app's own language and theme controls, so the choice made in the dashboard
 * is the one on `/docs`, and changing it here changes it everywhere (it is the same cookie and provider).
 */
export function DocsNavActions() {
  return (
    <div className="ms-auto flex items-center gap-2">
      <ThemeSwitcher />
      <LocaleSwitcher />
    </div>
  );
}
