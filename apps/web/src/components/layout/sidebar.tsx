'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  Activity,
  LayoutDashboard,
  KeyRound,
  ShieldCheck,
  Users,
  BarChart3,
  FileText,
  Settings,
  PanelLeftClose,
  PanelLeft,
  Layers,
  Package,
  CircleHelp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { TenantSwitcher } from '@/components/layout/tenant-switcher';
import { usePermissions } from '@/hooks/use-permissions';
import { RTL_LOCALES } from '@/i18n/locales';
import { BrandMark } from '@/components/layout/brand-mark';
import { useOverlays } from '@/components/layout/overlays-context';

type NavGroup = 'workspace' | 'manage' | 'trust';

interface NavItem {
  /** Key into the `nav` message namespace. */
  labelKey:
    | 'dashboard'
    | 'apis'
    | 'keys'
    | 'plans'
    | 'products'
    | 'tenants'
    | 'analytics'
    | 'traffic'
    | 'auditLogs'
    | 'settings';
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  group: NavGroup;
  /** Active only on `href` itself, not on the routes nested under it (`/analytics` vs `/analytics/traffic`). */
  exact?: boolean;
  /** Permission required to see the entry; omitted = always visible. */
  permission?: string;
}

/** Sidebar section order; each key is also a `nav.groups.*` message. */
const NAV_GROUPS: NavGroup[] = ['workspace', 'manage', 'trust'];

const navigation: NavItem[] = [
  { labelKey: 'dashboard', href: '/', icon: LayoutDashboard, group: 'workspace' },
  {
    labelKey: 'analytics',
    href: '/analytics',
    icon: BarChart3,
    group: 'workspace',
    permission: 'analytics:read',
    exact: true,
  },
  {
    labelKey: 'traffic',
    href: '/analytics/traffic',
    icon: Activity,
    group: 'workspace',
    permission: 'analytics:read',
  },
  { labelKey: 'apis', href: '/apis', icon: ShieldCheck, group: 'manage', permission: 'api:read' },
  { labelKey: 'keys', href: '/keys', icon: KeyRound, group: 'manage', permission: 'key:read' },
  { labelKey: 'plans', href: '/plans', icon: Layers, group: 'manage', permission: 'plan:read' },
  {
    labelKey: 'products',
    href: '/products',
    icon: Package,
    group: 'manage',
    permission: 'product:read',
  },
  {
    labelKey: 'tenants',
    href: '/tenants',
    icon: Users,
    group: 'manage',
    permission: 'tenant:read',
  },
  {
    labelKey: 'auditLogs',
    href: '/audit-logs',
    icon: FileText,
    group: 'trust',
    permission: 'audit:read',
  },
  {
    labelKey: 'settings',
    href: '/settings',
    icon: Settings,
    group: 'trust',
    permission: 'settings:read',
  },
];

/** The permission-gated entries the current user may see; shared by the desktop sidebar and the mobile sheet. */
export function useNavItems() {
  const pathname = usePathname();
  const { can } = usePermissions();
  const t = useTranslations('nav');

  // The Dashboard item is active only on `/`; every other item also owns its nested routes (/apis/:id, /keys/:id).
  const isActive = (href: string, exact = false) =>
    href === '/' || exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return navigation
    .filter((item) => !item.permission || can(item.permission))
    .map((item) => ({ ...item, label: t(item.labelKey), active: isActive(item.href, item.exact) }));
}

export const navLinkClass = (active: boolean, options?: { collapsed?: boolean }) => {
  const collapsed = options?.collapsed ?? false;
  return cn(
    'flex items-center text-sm font-medium transition-colors duration-200',
    collapsed
      ? // The icon rail: round buttons on a soft fill; the current page is a filled accent circle.
        'mx-auto size-11 justify-center rounded-full'
      : 'min-h-10 gap-3 rounded-full px-3.5 py-2 pointer-coarse:min-h-11',
    collapsed
      ? active
        ? 'bg-primary text-primary-foreground shadow-[0_6px_14px_-6px_var(--color-primary)]'
        : 'bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.12]'
      : active
        ? 'bg-primary/10 text-primary'
        : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
  );
};

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const items = useNavItems();
  const t = useTranslations('nav');
  const tDashboard = useTranslations('dashboard');
  // Radix tooltip sides are physical; in RTL the sidebar sits on the right, so they open leftwards.
  const tooltipSide = (RTL_LOCALES as readonly string[]).includes(useLocale()) ? 'left' : 'right';
  const { openHelp } = useOverlays();
  const helpButton = (
    <Button
      type="button"
      variant="ghost"
      onClick={openHelp}
      aria-label={collapsed ? t('help') : undefined}
      className={cn(
        'text-muted-foreground hover:text-foreground',
        collapsed ? 'size-11 p-0' : 'h-10 w-full justify-start gap-3 px-3.5 font-medium',
      )}
    >
      <CircleHelp className="h-[1.15rem] w-[1.15rem] shrink-0" aria-hidden="true" />
      {!collapsed && <span>{t('help')}</span>}
    </Button>
  );

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          // In the panel's flow (not fixed): sticky so it stays put while the page scrolls.
          'sticky top-0 flex h-dvh max-h-[calc(100dvh-3.5rem)] flex-col transition-[width] duration-300 ease-out',
          collapsed ? 'w-[5.25rem] items-center' : 'w-64 border-e',
        )}
      >
        {/* Brand + collapse toggle */}
        <div
          className={cn(
            'flex gap-3 px-4 pb-4 pt-5',
            collapsed ? 'flex-col items-center' : 'items-center',
          )}
        >
          <Link
            href="/"
            aria-label={t('brand')}
            className="bg-primary text-primary-foreground grid size-11 shrink-0 place-items-center rounded-2xl shadow-[0_6px_16px_-6px_var(--color-primary)]"
          >
            <BrandMark className="size-7" />
          </Link>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="text-base font-bold leading-none tracking-[0.16em]">{t('brand')}</div>
              <div className="text-muted-foreground mt-1.5 truncate font-mono text-[0.68rem]">
                {t('brandCaption')}
              </div>
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="bg-foreground/[0.06] hover:bg-foreground/[0.12] size-10 shrink-0 rounded-full"
                onClick={onToggle}
              >
                {/* Panel icons are drawn for a left-hand sidebar; mirror them when it sits on the right. */}
                {collapsed ? (
                  <PanelLeft className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
                ) : (
                  <PanelLeftClose className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
                )}
                <span className="sr-only">
                  {collapsed ? t('expandSidebar') : t('collapseSidebar')}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side={tooltipSide}>
              {collapsed ? t('expandSidebar') : t('collapseSidebar')}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Tenant context for everything below it (guidelines §8) — not in the top bar. */}
        <div className={cn('pb-3', collapsed ? 'px-2' : 'border-b px-2')}>
          <TenantSwitcher collapsed={collapsed} />
        </div>

        {/* Navigation, in the design's three sections; empty sections (no permission) disappear. */}
        <ScrollArea className="w-full flex-1 py-3">
          <nav
            className="flex flex-col gap-4 px-2"
            aria-label={tDashboard('mobileNav.description')}
          >
            {NAV_GROUPS.map((group) => {
              const groupItems = items.filter((item) => item.group === group);
              if (groupItems.length === 0) return null;
              return (
                <div
                  key={group}
                  className={cn(
                    'flex flex-col',
                    collapsed ? 'not-first:border-t not-first:pt-3 gap-2' : 'gap-1',
                  )}
                >
                  {!collapsed && (
                    <div className="text-muted-foreground mx-3.5 mb-1 font-mono text-[0.62rem] uppercase tracking-[0.12em]">
                      {t(`groups.${group}`)}
                    </div>
                  )}
                  {groupItems.map((item) => {
                    const Icon = item.icon;

                    const linkElement = (
                      <Link
                        href={item.href}
                        className={navLinkClass(item.active, { collapsed })}
                        aria-current={item.active ? 'page' : undefined}
                        // Collapsed, the icon is all that shows: the name still has to reach a screen reader.
                        aria-label={collapsed ? item.label : undefined}
                      >
                        <Icon className="h-[1.15rem] w-[1.15rem] shrink-0" aria-hidden="true" />
                        {!collapsed && <span>{item.label}</span>}
                      </Link>
                    );

                    if (collapsed) {
                      return (
                        <Tooltip key={item.href}>
                          <TooltipTrigger asChild>{linkElement}</TooltipTrigger>
                          <TooltipContent side={tooltipSide}>{item.label}</TooltipContent>
                        </Tooltip>
                      );
                    }

                    return <div key={item.href}>{linkElement}</div>;
                  })}
                </div>
              );
            })}
          </nav>
        </ScrollArea>

        {/* Help & shortcuts */}
        <div className={cn('w-full border-t px-2 py-3', collapsed && 'flex justify-center')}>
          {collapsed ? (
            <Tooltip>
              <TooltipTrigger asChild>{helpButton}</TooltipTrigger>
              <TooltipContent side={tooltipSide}>{t('help')}</TooltipContent>
            </Tooltip>
          ) : (
            helpButton
          )}
        </div>
      </aside>
    </TooltipProvider>
  );
}
