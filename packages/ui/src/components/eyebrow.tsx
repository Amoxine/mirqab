import * as React from 'react';
import { cn } from '../lib/utils';

/** The small mono uppercase caption used over figures, filter controls and list sections. */
export const Eyebrow = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'text-muted-foreground font-mono text-[0.66rem] uppercase tracking-[0.08em]',
        className,
      )}
      {...props}
    />
  ),
);
Eyebrow.displayName = 'Eyebrow';
