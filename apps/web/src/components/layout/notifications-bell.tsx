'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { Activity, Bell, CheckCheck, FileDiff, RefreshCwOff, ServerCrash } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAnalyticsHealth } from '@/hooks/use-analytics';
import { useGatewayStatus } from '@/hooks/use-gateway-status';
import { usePermissions } from '@/hooks/use-permissions';
import { useSpecUpdates } from '@/lib/api/spec-source';
import { dateFnsLocale } from '@/lib/date-fns-locale';
import { deriveNotifications, type AppNotification } from '@/lib/notifications';
import type { Locale } from '@/i18n/locales';

const READ_KEY = 'mirqab-notifications-read';

const ICONS = {
  gatewayDown: ServerCrash,
  pipelineDown: Activity,
  syncFailed: RefreshCwOff,
  specUpdate: FileDiff,
} satisfies Record<AppNotification['kind'], unknown>;

/**
 * Read state is per browser (localStorage): the notifications are derived, not stored, so there is
 * no server record to mark. Only ids still current are kept, so the list never grows.
 */
function useReadIds(currentIds: string[]) {
  const [read, setRead] = useState(new Set<string>());
  useEffect(() => {
    try {
      setRead(new Set(JSON.parse(localStorage.getItem(READ_KEY) ?? '[]') as string[]));
    } catch {
      // Storage blocked or corrupt: everything shows as unread, which is the safe side.
    }
  }, []);
  const markRead = (ids: string[]) => {
    const next = new Set([...read, ...ids].filter((id) => currentIds.includes(id)));
    setRead(next);
    try {
      localStorage.setItem(READ_KEY, JSON.stringify([...next]));
    } catch {
      // Not persisted; still read for this visit.
    }
  };
  return { read, markRead };
}

/** The header bell: gateway, sync and analytics problems and new spec versions the user may see. */
export function NotificationsBell() {
  const t = useTranslations('dashboard.notifications');
  const { can } = usePermissions();
  const locale = dateFnsLocale(useLocale() as Locale);
  // Each source behind the permission its endpoint requires, so nobody triggers a 403.
  const gateway = useGatewayStatus(can('settings:read'));
  const specUpdates = useSpecUpdates(can('api:read'));
  const health = useAnalyticsHealth(can('analytics:read'));

  const items = useMemo(
    () => deriveNotifications({ gateway: gateway.data, specUpdates: specUpdates.data, health: health.data }),
    [gateway.data, specUpdates.data, health.data],
  );
  const { read, markRead } = useReadIds(items.map((n) => n.id));
  const unread = items.filter((n) => !read.has(n.id)).length;
  // Controlled, so following a notification also closes the panel (the header outlives the page).
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={unread > 0 ? t('labelUnread', { count: unread }) : t('label')}
          className="bg-foreground/[0.06] hover:bg-foreground/[0.1] relative size-11 rounded-full"
        >
          <Bell className="h-4 w-4" aria-hidden="true" />
          {unread > 0 && (
            <span
              aria-hidden="true"
              className="bg-destructive text-destructive-foreground absolute -end-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full px-1 font-mono text-[0.65rem] font-semibold leading-none"
            >
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="text-sm font-semibold">{t('title')}</h2>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-8 gap-1.5 rounded-full px-2.5 text-xs"
              onClick={() => {
                markRead(items.map((n) => n.id));
              }}
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {t('markAllRead')}
            </Button>
          )}
        </div>
        {items.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm font-medium">{t('empty')}</p>
            <p className="text-muted-foreground mt-1 text-xs">{t('emptyHint')}</p>
          </div>
        ) : (
          <ul className="max-h-[22rem] overflow-y-auto py-1">
            {items.map((n) => {
              const Icon = ICONS[n.kind];
              const isUnread = !read.has(n.id);
              const name = 'apiName' in n ? n.apiName : '';
              return (
                <li key={n.id}>
                  <Link
                    href={n.href}
                    onClick={() => {
                      markRead([n.id]);
                      setOpen(false);
                    }}
                    className="hover:bg-accent flex gap-3 px-4 py-2.5 outline-none focus-visible:bg-accent"
                  >
                    <span
                      className={cn(
                        'mt-0.5 grid size-8 shrink-0 place-items-center rounded-full',
                        n.kind === 'specUpdate' ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive',
                      )}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-sm leading-snug', isUnread && 'font-semibold')}>
                        {t(`${n.kind}.title`, { name })}
                      </span>
                      <span className="text-muted-foreground block text-xs leading-snug">{t(`${n.kind}.body`)}</span>
                      {n.at && (
                        <time dateTime={n.at} className="text-muted-foreground mt-0.5 block text-[0.7rem]">
                          {formatDistanceToNow(new Date(n.at), { addSuffix: true, locale })}
                        </time>
                      )}
                    </span>
                    {isUnread && <span className="bg-primary mt-2 size-2 shrink-0 rounded-full" aria-label={t('unread')} />}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
