import type { ReactNode } from 'react';
import { Badge, type BadgeProps } from './badge';

export interface StatusBadgeProps<T extends string> {
  status: T;
  /** Badge variant per status. */
  variants: Record<T, NonNullable<BadgeProps['variant']>>;
  /** Visible text per status (translated by the caller). */
  labels: Record<T, ReactNode>;
  className?: string;
}

/** A status chip: one lookup of variant and text per status, so every domain renders them the same way. */
export function StatusBadge<T extends string>({
  status,
  variants,
  labels,
  className,
}: StatusBadgeProps<T>) {
  return (
    <Badge variant={variants[status]} className={className}>
      {labels[status]}
    </Badge>
  );
}
