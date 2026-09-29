import { cn } from '../lib/utils';
import { Progress } from './progress';

export interface ShareItem {
  key: string;
  label: string;
  value: number;
  /** Colour of the bar (a `bg-*` class), e.g. `bg-destructive` for failing traffic. */
  indicatorClassName?: string;
}

export interface ShareListProps {
  items: ShareItem[];
  /** What the shares are measured against. Default: the sum of the items. */
  total?: number;
  /** Text at the end of each row, e.g. "23,900 · 96.4%". Receives the value and its 0-100 share. */
  format: (value: number, share: number) => string;
  className?: string;
}

/** Rows of `label … value` over a progress bar: how a total splits (status classes, methods, APIs). */
export function ShareList({ items, total, format, className }: ShareListProps) {
  const sum = total ?? items.reduce((acc, item) => acc + item.value, 0);
  return (
    <ul className={cn('space-y-2.5', className)}>
      {items.map((item) => {
        const share = sum > 0 ? (item.value / sum) * 100 : 0;
        return (
          <li key={item.key} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span dir="auto" className="truncate">
                {item.label}
              </span>
              <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
                {format(item.value, share)}
              </span>
            </div>
            <Progress
              value={share}
              aria-hidden="true"
              indicatorClassName={item.indicatorClassName}
            />
          </li>
        );
      })}
    </ul>
  );
}
