'use client';

import Link from 'next/link';
import { ArrowUpRight, Server } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { AnalyticsErrorState } from '@/components/analytics/analytics-empty-state';
import { BrandMark } from '@/components/layout/brand-mark';
import { StateMessage } from '@/components/shared/state-card';
import { Skeleton } from '@/components/ui/skeleton';
import { useNodeHealth } from '@/hooks/use-settings';
import { useFormat } from '@/hooks/use-format';
import { RTL_LOCALES } from '@/i18n/locales';
import { cn } from '@/lib/utils';
import type { NodeHealthEntry } from '@/types';
import { fx, usePrefersReducedMotion } from './viz-utils';

/** Diagram space: 100 × 62.5 (16:10), matched by the container's aspect ratio so nothing is stretched. */
const W = 100;
const H = 62.5;
const HUB = { x: 50, y: 33 };
const MAX_NODES = 8;

function hostOf(nodeUrl: string): string {
  try {
    return new URL(nodeUrl).host;
  } catch {
    return nodeUrl;
  }
}

/** Nodes on an ellipse around the hub, first one at the top, clockwise. */
function layout(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + (count === 2 ? Math.PI / 2 : 0) + (i * 2 * Math.PI) / count;
    return { x: HUB.x + Math.cos(angle) * 34, y: HUB.y + Math.sin(angle) * 21 };
  });
}

/** Slightly bowed spoke from the hub to a node; returns the path and its midpoint (for the latency pill). */
function spoke(to: { x: number; y: number }) {
  const dx = to.x - HUB.x;
  const dy = to.y - HUB.y;
  const len = Math.hypot(dx, dy) || 1;
  const cx = (HUB.x + to.x) / 2 - (dy / len) * len * 0.12;
  const cy = (HUB.y + to.y) / 2 + (dx / len) * len * 0.12;
  return {
    d: `M${fx(HUB.x)},${fx(HUB.y)} Q${fx(cx)},${fx(cy)} ${fx(to.x)},${fx(to.y)}`,
    mx: 0.25 * HUB.x + 0.5 * cx + 0.25 * to.x,
    my: 0.25 * HUB.y + 0.5 * cy + 0.25 * to.y,
  };
}

function Diagram({ nodes }: { nodes: NodeHealthEntry[] }) {
  const t = useTranslations('dashboard.topology');
  const tNav = useTranslations('nav');
  const fmt = useFormat();
  const locale = useLocale();
  const reduced = usePrefersReducedMotion();
  const textDir = (RTL_LOCALES as readonly string[]).includes(locale) ? 'rtl' : 'ltr';
  const shown = nodes.slice(0, MAX_NODES);
  const points = layout(shown.length);
  const pct = (v: number, of: number) => `${fx((v / of) * 100)}%`;

  const redisLabel = {
    pass: t('redis.pass'),
    fail: t('redis.fail'),
    unknown: t('redis.unknown'),
  } as const;

  return (
    // Geometry is laid out left-to-right in every locale; the text inside the cards follows the UI direction.
    <div dir="ltr" className="relative aspect-[16/10] w-full">
      <div
        className="bg-dot-grid absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,#000_45%,transparent_75%)]"
        aria-hidden="true"
      />
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-visible"
        aria-hidden="true"
      >
        {shown.map((node, i) => {
          const point = points[i];
          if (!point) return null;
          const up = node.health.reachable;
          const { d } = spoke(point);
          const id = `spoke-${String(i)}`;
          return (
            <g key={node.nodeUrl}>
              <path
                id={id}
                d={d}
                fill="none"
                stroke={up ? 'var(--color-primary)' : 'var(--color-destructive)'}
                strokeOpacity={up ? 0.55 : 0.7}
                strokeWidth={1.5}
                strokeDasharray={up ? undefined : '4 4'}
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
              />
              {/* Probe traffic along healthy spokes only: an unreachable node gets a dashed, still line. */}
              {up &&
                !reduced &&
                [0, 1].map((k) => (
                  <g key={k}>
                    <circle r={1.4} fill="var(--color-primary)" fillOpacity={0.18} />
                    <circle r={0.6} fill="var(--color-primary)" />
                    <animateMotion
                      dur="3.2s"
                      begin={`${fx(-k * 1.6 - i * 0.4)}s`}
                      repeatCount="indefinite"
                      keyPoints={k ? '1;0' : '0;1'}
                      keyTimes="0;1"
                      calcMode="linear"
                    >
                      <mpath href={`#${id}`} />
                    </animateMotion>
                    <animate
                      attributeName="opacity"
                      values="0;1;1;0"
                      keyTimes="0;0.12;0.88;1"
                      dur="3.2s"
                      begin={`${fx(-k * 1.6 - i * 0.4)}s`}
                      repeatCount="indefinite"
                    />
                  </g>
                ))}
            </g>
          );
        })}
      </svg>

      {/* Probe round-trip on each spoke, from the control plane's /hello check. */}
      {shown.map((node, i) => {
        const point = points[i];
        if (!point || node.health.latencyMs === null) return null;
        const { mx, my } = spoke(point);
        return (
          <span
            key={`rtt-${node.nodeUrl}`}
            className="border-primary/40 bg-card/85 absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[0.66rem] backdrop-blur-sm"
            style={{ left: pct(mx, W), top: pct(my, H) }}
            title={t('probeLatency')}
          >
            {fmt.ms(node.health.latencyMs)}
          </span>
        );
      })}

      {/* Hub: the MIRQAB control plane. */}
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: pct(HUB.x, W), top: pct(HUB.y, H) }}
      >
        <div className="bg-secondary text-secondary-foreground ring-background grid size-14 place-items-center rounded-2xl shadow-[0_12px_28px_-12px_rgb(2_6_23/0.6)] ring-4">
          <BrandMark className="size-8" />
        </div>
        <div
          dir={textDir}
          className="text-muted-foreground absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap text-center font-mono text-[0.66rem]"
        >
          {`${tNav('brand')} · ${t('controlPlane')}`}
        </div>
      </div>

      {/* Nodes */}
      {shown.map((node, i) => {
        const point = points[i];
        if (!point) return null;
        const up = node.health.reachable;
        const above = point.y < HUB.y;
        return (
          <div
            key={node.nodeUrl}
            className="absolute"
            style={{ left: pct(point.x, W), top: pct(point.y, H) }}
          >
            <span className="absolute -start-[11px] -top-[11px] block size-[22px]">
              {up && (
                <span
                  className="motion-pulse-ring border-primary absolute inset-0 rounded-full border-[1.5px]"
                  style={{ animationDelay: `${fx(i * 0.9)}s` }}
                  aria-hidden="true"
                />
              )}
              <svg
                viewBox="0 0 24 24"
                className="relative block size-[22px] overflow-visible"
                aria-hidden="true"
              >
                <path
                  d="M12 2.2 20.6 7.1v9.8L12 21.8 3.4 16.9V7.1Z"
                  fill={up ? 'var(--color-primary)' : 'var(--color-destructive)'}
                  stroke="var(--color-background)"
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                />
                <circle cx={12} cy={12} r={3} fill="var(--color-background)" />
              </svg>
            </span>
            <div
              dir={textDir}
              className={cn(
                'bg-card/85 absolute left-0 w-max max-w-[11rem] -translate-x-1/2 rounded-xl border px-3 py-2 text-start shadow-md backdrop-blur-md',
                above ? 'bottom-5' : 'top-5',
              )}
            >
              <div className="text-primary truncate font-mono text-[0.68rem]" dir="ltr">
                {hostOf(node.nodeUrl)}
              </div>
              <div className={cn('text-[0.82rem] font-medium', !up && 'text-destructive')}>
                {up ? t('reachable') : t('unreachable')}
              </div>
              <div className="text-muted-foreground truncate font-mono text-[0.66rem]">
                {up
                  ? `${node.health.version ?? '—'} · ${t('redisShort')} ${redisLabel[node.health.redis]}`
                  : (node.health.error ?? t('noResponse'))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The dashboard's centrepiece: the control plane and every configured gateway node, with each node's
 * reachability, version, Redis state and probe latency from `GET /gateway/nodes/health`.
 */
export function GatewayTopology() {
  const t = useTranslations('dashboard.topology');
  const { data, isLoading, error, refetch } = useNodeHealth();
  const up = data?.filter((n) => n.health.reachable).length ?? 0;

  return (
    <section aria-labelledby="topology-title" className="relative flex min-w-0 flex-col">
      <div className="relative z-10 flex items-start justify-between gap-3 px-1">
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

      <div className="relative mt-2 flex flex-1 items-center">
        {isLoading ? (
          <Skeleton className="aspect-[16/10] w-full rounded-[1.25rem]" />
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
            className="w-full py-10"
          />
        ) : (
          <div className="w-full">
            <Diagram nodes={data} />
            {data.length > MAX_NODES && (
              <p className="text-muted-foreground mt-2 text-center text-sm">
                <Link href="/settings" className="text-primary hover:underline">
                  {t('more', { count: data.length - MAX_NODES })}
                </Link>
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
