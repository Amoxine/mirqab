import type { ComponentType, ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Card } from './card';
import { Eyebrow } from './eyebrow';
import { Skeleton } from './skeleton';

export interface KpiTileProps {
  label: string;
  /** The figure; pass a formatted node for a number with its small unit, or a plain string. */
  value: ReactNode;
  /** One line of context under the figure (a breakdown, a comparison, a period). */
  hint?: ReactNode;
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  /** Colours the figure when the metric is in a good, warning or bad state. */
  tone?: 'default' | 'good' | 'warn' | 'bad';
  className?: string;
}

const TONE = {
  default: '',
  good: 'text-success',
  warn: 'text-warning',
  bad: 'text-destructive',
} as const;

/**
 * A compact KPI tile: a mono caption, one large light figure and a line of context. Deliberately
 * small so a row of five or six fits without dead space.
 */
export function KpiTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
  className,
}: KpiTileProps) {
  return (
    <Card className={cn('flex min-w-0 flex-col justify-between gap-2 p-3.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <Eyebrow className="truncate">{label}</Eyebrow>
        {Icon && <Icon className="text-muted-foreground h-3.5 w-3.5 shrink-0" aria-hidden />}
      </div>
      {/* tabular-nums: digits keep their width, so a refetch doesn't make the tile jitter. */}
      <div
        className={cn(
          'text-[1.7rem] font-light tabular-nums leading-none tracking-[-0.04em]',
          TONE[tone],
        )}
      >
        {value}
      </div>
      {hint && <p className="text-muted-foreground truncate text-xs">{hint}</p>}
    </Card>
  );
}

/** Same footprint as `KpiTile`, so a row does not shift when data arrives. */
export function KpiTileSkeleton() {
  return (
    <Card aria-hidden="true" className="flex flex-col justify-between gap-2 p-3.5">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-7 w-24" />
      <Skeleton className="h-3 w-28" />
    </Card>
  );
}
