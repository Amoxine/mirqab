import { cn } from '../lib/utils';
import { Progress } from './progress';

export interface ShareItem {
  key: string;
  label: string;
  value: number;
  /** Colour of the bar (a `bg-*` class), e.g. `bg-destructive` for failing traffic. */
  indicatorClassName?: string;
  /** Makes the row a toggle button ("show only this one"); it reports a press, the caller decides what it does. */
  onSelect?: () => void;
  /** Whether the row's choice is the active one; announced as pressed, and shown by a rule at its start and by weight, not by colour or fill alone. */
  selected?: boolean;
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
        const head = (
          <>
            <span dir="auto" className="truncate">
              {item.label}
            </span>
            <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
              {format(item.value, share)}
            </span>
          </>
        );
        return (
          <li key={item.key} className="space-y-1">
            {item.onSelect ? (
              <button
                type="button"
                aria-pressed={item.selected ?? false}
                onClick={item.onSelect}
                className="hover:bg-accent focus-visible:ring-ring aria-pressed:bg-accent aria-pressed:border-foreground aria-pressed:font-medium flex w-full items-baseline justify-between gap-2 rounded-sm border-s-2 border-transparent ps-1.5 text-start text-sm focus-visible:outline-hidden focus-visible:ring-2"
              >
                {head}
              </button>
            ) : (
              <div className="flex items-baseline justify-between gap-2 text-sm">{head}</div>
            )}
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
