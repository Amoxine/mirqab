'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
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
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { usePermissions } from '@/hooks/use-permissions';

interface NavItem {
  /** Key into the `nav` message namespace. */
  labelKey: 'dashboard' | 'apis' | 'keys' | 'tenants' | 'analytics' | 'auditLogs' | 'settings';
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Permission required to see the entry; omitted = always visible. */
  permission?: string;
}

const navigation: NavItem[] = [
  { labelKey: 'dashboard', href: '/', icon: LayoutDashboard },
  { labelKey: 'apis', href: '/apis', icon: ShieldCheck, permission: 'api:read' },
  { labelKey: 'keys', href: '/keys', icon: KeyRound, permission: 'key:read' },
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

export const navLinkClass = (active: boolean) =>
  cn(
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
    active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
  );

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const items = useNavItems();
  const t = useTranslations('nav');

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          // ponytail: `start-0`/`border-e` (not `left-0`/`border-r`) so the sidebar mounts on the
          // correct physical side and border in RTL — confirmed valid Tailwind v4.1 logical inset utility.
          'fixed inset-y-0 start-0 z-50 flex flex-col border-e bg-background transition-all duration-300 lg:z-0',
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
                {collapsed ? (
                  <PanelLeft className="h-4 w-4" />
                ) : (
                  <PanelLeftClose className="h-4 w-4" />
                )}
                <span className="sr-only">
                  {collapsed ? t('expandSidebar') : t('collapseSidebar')}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {collapsed ? t('expandSidebar') : t('collapseSidebar')}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Navigation */}
        <ScrollArea className="flex-1 py-4">
          <nav className="flex flex-col gap-1 px-2">
            {items.map((item) => {
              const Icon = item.icon;

              const linkElement = (
                <Link href={item.href} className={navLinkClass(item.active)}>
                  <Icon className="h-5 w-5 shrink-0" />
                  {!collapsed && <span>{item.label}</span>}
                </Link>
              );

              if (collapsed) {
                return (
                  <Tooltip key={item.href}>
                    <TooltipTrigger asChild>{linkElement}</TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
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
