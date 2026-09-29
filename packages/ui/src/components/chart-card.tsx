import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './card';
import { Skeleton } from './skeleton';

export interface ChartCardProps {
  title: string;
  description: string;
  /** What the body shows: a skeleton, the error/empty content, or the chart itself. */
  status: 'loading' | 'error' | 'empty' | 'ready';
  /** Rendered for `status="error"` (an `ErrorState` with its retry). */
  errorContent?: ReactNode;
  /** Rendered for `status="empty"`. */
  emptyContent?: ReactNode;
  /** Height of the body box, a Tailwind class. Default `h-[280px]`. */
  heightClass?: string;
  /** The chart; rendered inside the fixed-height box, so use `<ResponsiveContainer height="100%">`. */
  children: ReactNode;
}

/** A card whose body is never an empty canvas: skeleton while loading, retryable error, empty state, or the chart. */
export function ChartCard({
  title,
  description,
  status,
  errorContent,
  emptyContent,
  heightClass = 'h-[280px]',
  children,
}: ChartCardProps) {
  let body: ReactNode;
  if (status === 'loading') body = <Skeleton className="h-full w-full" />;
  else if (status === 'error') body = errorContent;
  else if (status === 'empty') body = emptyContent;
  else
    // The chart is an image to assistive tech; the tables beside it carry the same data as text.
    body = (
      <div role="img" aria-label={`${title}. ${description}`} className="h-full">
        {children}
      </div>
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className={heightClass}>{body}</div>
      </CardContent>
    </Card>
  );
}
