'use client';

import { fx, useElementWidth } from '../lib/viz';
import { cn } from '../lib/utils';

export interface SparklineProps {
  values: number[];
  /** Fill a 10% wash under the line (volume-like series). */
  area?: boolean;
  height?: number;
  className?: string;
}

/**
 * 2px trend line with an emphasised end point. Decorative: the figure beside it carries the value.
 *
 * It draws at the width its wrapper has. The svg is out of flow (`absolute` in a `relative` wrapper that holds the
 * height itself) so it adds nothing to the intrinsic width of what contains it: in flow, a fixed-width svg held a
 * grid column of `auto` width (and so the wrapper) at the width it was drawn, the wrapper could never get narrower,
 * and the page kept its old width after the viewport shrank in place.
 */
export function Sparkline({ values, area = false, height = 44, className }: SparklineProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const pad = 5;
  const max = Math.max(...values, 0) * 1.08 || 1;
  const x = (i: number) =>
    values.length > 1 ? pad + (i / (values.length - 1)) * (width - pad * 2) : width / 2;
  const y = (v: number) => height - 3 - (v / max) * (height - 8);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${fx(x(i))},${fx(y(v))}`).join('');
  const last = values.length - 1;

  return (
    <div ref={ref} className={cn('relative', className)} style={{ height }} aria-hidden="true" dir="ltr">
      {width > 0 && values.length > 1 && (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${fx(width)} ${fx(height)}`}
          className="absolute left-0 top-0 block overflow-visible"
        >
          {area && (
            <path
              d={`${line}L${fx(x(last))},${fx(height)}L${fx(x(0))},${fx(height)}Z`}
              fill="var(--color-primary)"
              fillOpacity={0.1}
            />
          )}
          <path
            d={line}
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <circle
            cx={x(last)}
            cy={y(values[last] ?? 0)}
            r={4}
            fill="var(--color-primary)"
            stroke="var(--color-card)"
            strokeWidth={2}
          />
        </svg>
      )}
    </div>
  );
}
