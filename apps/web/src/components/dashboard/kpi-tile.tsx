import type { ComponentType, ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface KpiTileProps {
  label: string;
  /** The figure; pass a `Figure` for a number with its small unit, or a plain string. */
  value: ReactNode;
  /** One line of context under the figure (a breakdown, a comparison, a period). */
  hint?: ReactNode;
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  /** Colours the figure when the metric is in a bad or good state. */
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
 * The compact KPI tile shared by the home page and the traffic page: a mono caption, one large
 * light figure and a line of context. Deliberately small so a row of six fits without dead space.
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
        <span className="text-muted-foreground truncate font-mono text-[0.66rem] uppercase tracking-[0.08em]">
          {label}
        </span>
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
