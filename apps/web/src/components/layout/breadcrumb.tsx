'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronRight, Home } from 'lucide-react';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BreadcrumbItem {
  label: string;
  href: string;
}

export function Breadcrumb() {
  const pathname = usePathname();
  const t = useTranslations('dashboard.breadcrumb');
  const segments = pathname.split('/').filter(Boolean);

  const labelMap: Partial<Record<string, string>> = {
    apis: t('apis'),
    keys: t('keys'),
    tenants: t('tenants'),
    analytics: t('analytics'),
    'audit-logs': t('auditLogs'),
    login: t('login'),
  };

  const breadcrumbs: BreadcrumbItem[] = segments.map((segment, index) => {
    const href = `/${segments.slice(0, index + 1).join('/')}`;
    const label = labelMap[segment] ?? (UUID_RE.test(segment) ? t('details') : segment).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return { label, href };
  });

  if (breadcrumbs.length === 0) {
    return (
      <nav aria-label={t('ariaLabel')} className="flex items-center gap-1 text-sm text-muted-foreground">
        <Home className="h-4 w-4" />
        <span className="font-medium text-foreground">{t('home')}</span>
      </nav>
    );
  }

  return (
    <nav aria-label={t('ariaLabel')} className="flex items-center gap-1 text-sm text-muted-foreground">
      <Link
        href="/"
        aria-label={t('home')}
        className="flex items-center gap-1 transition-colors hover:text-foreground"
      >
        <Home className="h-4 w-4" />
        {/* Icon-only on phones: the header also has to fit the tenant name. */}
        <span className="hidden sm:inline">{t('home')}</span>
      </Link>
      {breadcrumbs.map((crumb, index) => {
        const isLast = index === breadcrumbs.length - 1;
        return (
          <span key={crumb.href} className="flex items-center gap-1">
            {/* Points visual "forward" — flip in RTL so it doesn't read backwards. */}
            <ChevronRight className="h-4 w-4 shrink-0 rtl:rotate-180" />
            {isLast ? (
              <span className="font-medium text-foreground">{crumb.label}</span>
            ) : (
              <Link
                href={crumb.href}
                className="transition-colors hover:text-foreground"
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
