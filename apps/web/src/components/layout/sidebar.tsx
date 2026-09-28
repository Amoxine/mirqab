'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
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
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { TenantSwitcher } from '@/components/layout/tenant-switcher';
import { usePermissions } from '@/hooks/use-permissions';
import { RTL_LOCALES } from '@/i18n/locales';

interface NavItem {
  /** Key into the `nav` message namespace. */
  labelKey: 'dashboard' | 'apis' | 'keys' | 'plans' | 'products' | 'tenants' | 'analytics' | 'auditLogs' | 'settings';
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Permission required to see the entry; omitted = always visible. */
  permission?: string;
}

const navigation: NavItem[] = [
  { labelKey: 'dashboard', href: '/', icon: LayoutDashboard },
  { labelKey: 'apis', href: '/apis', icon: ShieldCheck, permission: 'api:read' },
  { labelKey: 'keys', href: '/keys', icon: KeyRound, permission: 'key:read' },
  { labelKey: 'plans', href: '/plans', icon: Layers, permission: 'plan:read' },
  { labelKey: 'products', href: '/products', icon: Package, permission: 'product:read' },
  { labelKey: 'tenants', href: '/tenants', icon: Users, permission: 'tenant:read' },
  { labelKey: 'analytics', href: '/analytics', icon: BarChart3, permission: 'analytics:read' },
  { labelKey: 'auditLogs', href: '/audit-logs', icon: FileText, permission: 'audit:read' },
  { labelKey: 'settings', href: '/settings', icon: Settings, permission: 'settings:read' },
];

/** The permission-gated entries the current user may see; shared by the desktop sidebar and the mobile sheet. */
export function useNavItems() {
  const pathname = usePathname();
  const { can } = usePermissions();
  const t = useTranslations('nav');

  // The Dashboard item is active only on `/`; every other item also owns its nested routes (/apis/:id, /keys/:id).
  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

  return navigation
    .filter((item) => !item.permission || can(item.permission))
    .map((item) => ({ ...item, label: t(item.labelKey), active: isActive(item.href) }));
}

export const navLinkClass = (active: boolean, options?: { collapsed?: boolean }) => {
  const collapsed = options?.collapsed ?? false;
  return cn(
    'flex min-h-10 items-center gap-3 rounded-lg py-2 text-sm font-medium transition-colors duration-200 pointer-coarse:min-h-11',
    collapsed && 'justify-center px-0',
    !collapsed && (active ? 'border-s-2 border-primary ps-[calc(0.75rem-2px)] pe-3' : 'px-3'),
    active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
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

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          // ponytail: `start-0`/`border-e` (not `left-0`/`border-r`) so the sidebar mounts on the
          // correct physical side and border in RTL — confirmed valid Tailwind v4.1 logical inset utility.
          'fixed inset-y-0 start-0 z-50 flex flex-col border-e bg-background transition-[width] duration-300 ease-out lg:z-0',
          collapsed ? 'w-16' : 'w-64'
        )}
      >
        {/* Logo / Brand */}
        <div className="flex h-16 items-center justify-between border-b px-4">
          {!collapsed && (
            <Link href="/" className="text-lg font-bold tracking-tight">
              {t('brand')}
            </Link>
          )}
          {collapsed && (
            <span className="mx-auto text-lg font-bold">{t('brandShort')}</span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
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
        <div className="border-b p-2">
          <TenantSwitcher collapsed={collapsed} />
        </div>

        {/* Navigation */}
        <ScrollArea className="flex-1 py-4">
          <nav className="flex flex-col gap-1 px-2" aria-label={tDashboard('mobileNav.description')}>
            {items.map((item) => {
              const Icon = item.icon;

              const linkElement = (
                <Link
                  href={item.href}
                  className={navLinkClass(item.active, { collapsed })}
                  aria-current={item.active ? 'page' : undefined}
                  // Collapsed, the icon is all that shows: the name still has to reach a screen reader.
                  aria-label={collapsed ? item.label : undefined}
                >
                  <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
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
          </nav>
        </ScrollArea>
      </aside>
    </TooltipProvider>
  );
}
