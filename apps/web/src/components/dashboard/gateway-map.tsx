'use client';

import Link from 'next/link';
import { ArrowUpRight, Server } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { WorldMap, type WorldMapNode } from '@open-gateway/ui';
import { AnalyticsErrorState } from '@/components/analytics/analytics-empty-state';
import { StateMessage } from '@/components/shared/state-card';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/hooks/use-format';
import { useNodeHealth } from '@/hooks/use-settings';
import { locationOf, type GatewayLocation } from '@/lib/gateway-locations';
import { cn } from '@/lib/utils';
import type { NodeHealthEntry } from '@/types';

function hostOf(nodeUrl: string): string {
  try {
    return new URL(nodeUrl).host;
  } catch {
    return nodeUrl;
  }
}

/**
 * The API's own `health.error` strings (`GET /gateway/nodes/health`) are English and are never
 * printed: a known one maps to a translated reason here, anything else reads as "no response".
 */
const UNREACHABLE_REASON: Record<string, string> = {
  'Gateway health check timed out': 'timedOut',
};

function NodeMap({ nodes }: { nodes: NodeHealthEntry[] }) {
  const t = useTranslations('dashboard.topology');
  const fmt = useFormat();

  const detail = (node: NodeHealthEntry) =>
    node.health.reachable
      ? [node.health.version, node.health.latencyMs === null ? null : fmt.ms(node.health.latencyMs)]
          .filter(Boolean)
          .join(' · ')
      : t(UNREACHABLE_REASON[node.health.error ?? ''] ?? 'noResponse');

  const cities = nodes.map((node) => locationOf(hostOf(node.nodeUrl))?.city);

  // Nodes at the same coordinates share one pin: two label cards at one point sit exactly on top of
  // each other (the pills below the map still list every node).
  const places = new Map<string, { loc: GatewayLocation; nodes: NodeHealthEntry[] }>();
  for (const node of nodes) {
    const loc = locationOf(hostOf(node.nodeUrl));
    if (!loc) continue;
    const key = `${String(loc.lat)},${String(loc.lon)}`;
    const place = places.get(key);
    if (place) place.nodes.push(node);
    else places.set(key, { loc, nodes: [node] });
  }
  const located = [...places.entries()].map(([key, { loc, nodes: group }]): WorldMapNode => {
    const [only] = group;
    const reachable = group.filter((node) => node.health.reachable).length;
    return {
      id: key,
      title: loc.city,
      ...(loc.code ? { code: loc.code } : {}),
      detail: group.length === 1 && only ? detail(only) : t('summary', { up: reachable, total: group.length }),
      lat: loc.lat,
      lon: loc.lon,
      up: reachable === group.length,
    };
  });

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      {located.length > 0 && (
        // The map covers whatever height the card is given (never less than 15rem), so the card
        // has no empty band above or below it.
        <div className="-mx-2 min-h-[15rem] flex-1">
          <WorldMap
            cover
            nodes={located}
            label={t('mapLabel', { nodes: located.map((n) => n.title).join(', ') })}
          />
        </div>
      )}
      {/* Text version of every node (also the only place unlocated nodes appear). */}
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {nodes.map((node, index) => {
          const up = node.health.reachable;
          // The host is only the key to the location lookup: it carries the gateway's internal name.
          // A city shared by several nodes gets the position too, so their pills stay distinguishable.
          const position = t('nodeLabel', { index: index + 1 });
          const city = cities[index];
          const label = !city ? position : cities.filter((c) => c === city).length > 1 ? `${city} · ${position}` : city;
          return (
            <li
              key={node.nodeUrl}
              className="bg-card/70 flex min-w-0 items-center gap-2 rounded-full border px-2.5 py-1 text-xs"
            >
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  up ? 'bg-success' : 'bg-destructive',
                )}
                aria-hidden="true"
              />
              <span className="truncate">{label}</span>
              <span className={cn('shrink-0', up ? 'text-muted-foreground' : 'text-destructive')}>
                {up ? t('reachable') : t('unreachable')}
              </span>
              <span className="text-muted-foreground hidden truncate font-mono sm:inline">
                {detail(node)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Gateway nodes on a world map (pins where a location is configured), with each node's health as text. */
export function GatewayMap() {
  const t = useTranslations('dashboard.topology');
  const { data, isLoading, error, refetch } = useNodeHealth();
  const up = data?.filter((n) => n.health.reachable).length ?? 0;

  return (
    <section aria-labelledby="topology-title" className="relative flex h-full min-w-0 flex-col">
      <div className="flex items-start justify-between gap-3 px-1">
        <div>
          <h2 id="topology-title" className="text-lg font-normal tracking-tight">
            {t('title')}
          </h2>
          {data && data.length > 0 && (
            <p
              className={cn(
                'text-sm',
                up === data.length ? 'text-muted-foreground' : 'text-destructive',
              )}
            >
              {t('summary', { up, total: data.length })}
            </p>
          )}
        </div>
        <Link
          href="/settings"
          aria-label={t('open')}
          className="bg-foreground text-background grid size-8 shrink-0 place-items-center rounded-full transition-transform duration-300 hover:rotate-45 rtl:-scale-x-100"
        >
          <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>

      <div className="relative mt-1 flex min-h-0 flex-1 flex-col justify-center">
        {isLoading ? (
          <Skeleton className="aspect-[128/67] w-full rounded-[1.25rem]" />
        ) : error ? (
          <AnalyticsErrorState
            message={error.message}
            onRetry={() => void refetch()}
            className="w-full"
          />
        ) : !data?.length ? (
          <StateMessage
            icon={<Server aria-hidden="true" />}
            message={t('empty')}
            className="w-full py-8"
          />
        ) : (
          <NodeMap nodes={data} />
        )}
      </div>
    </section>
  );
}
