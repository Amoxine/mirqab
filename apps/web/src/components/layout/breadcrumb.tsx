'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronRight, Home } from 'lucide-react';

interface BreadcrumbItem {
  label: string;
  href: string;
}

/**
 * URL segment -> `dashboard.breadcrumb` message key. Every static route under `app/(dashboard)` needs
 * an entry (breadcrumb.test.tsx walks the file tree and checks all three locales); a segment that is
 * not here is an id, and reads as "Details", never as the raw URL text.
 */
export const SEGMENT_KEYS: Record<string, string> = {
  apis: 'apis',
  keys: 'keys',
  tenants: 'tenants',
  analytics: 'analytics',
  traffic: 'traffic',
  search: 'search',
  'audit-logs': 'auditLogs',
  plans: 'plans',
  products: 'products',
  settings: 'settings',
  roles: 'roles',
  certificates: 'certificates',
  login: 'login',
};

export function Breadcrumb() {
  const pathname = usePathname();
  const t = useTranslations('dashboard.breadcrumb');
  const segments = pathname.split('/').filter(Boolean);

  const breadcrumbs: BreadcrumbItem[] = segments.map((segment, index) => {
    const href = `/${segments.slice(0, index + 1).join('/')}`;
    const key = Object.hasOwn(SEGMENT_KEYS, segment) ? SEGMENT_KEYS[segment] : undefined;
    return { label: key ? t(key) : t('details'), href };
  });

  if (breadcrumbs.length === 0) {
    return (
      <nav aria-label={t('ariaLabel')} className="flex items-center gap-1 text-sm text-muted-foreground">
        <Home className="h-4 w-4" aria-hidden="true" />
        <span className="font-medium text-foreground" aria-current="page">{t('home')}</span>
      </nav>
    );
  }

  return (
    <nav aria-label={t('ariaLabel')} className="flex items-center gap-1 text-sm text-muted-foreground">
      <Link
        href="/"
        aria-label={t('home')}
        className="flex shrink-0 items-center gap-1 rounded-sm transition-colors hover:text-foreground"
      >
        <Home className="h-4 w-4" aria-hidden="true" />
        {/* Icon-only on phones: the header also has to fit the tenant name. */}
        <span className="hidden sm:inline">{t('home')}</span>
      </Link>
      {breadcrumbs.map((crumb, index) => {
        const isLast = index === breadcrumbs.length - 1;
        return (
          <span key={crumb.href} className={isLast ? 'flex min-w-0 items-center gap-1' : 'hidden items-center gap-1 sm:flex'}>
            {/* Points visual "forward" — flip in RTL so it doesn't read backwards. */}
            <ChevronRight className="h-4 w-4 shrink-0 rtl:rotate-180" aria-hidden="true" />
            {isLast ? (
              <span className="truncate font-medium text-foreground" aria-current="page">{crumb.label}</span>
            ) : (
              <Link
                href={crumb.href}
                className="rounded-sm transition-colors hover:text-foreground"
              >
                {crumb.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
