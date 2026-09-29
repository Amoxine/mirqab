'use client';

import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import { cn } from '../lib/utils';

/** shadcn Progress; `indicatorClassName` recolours the bar (e.g. warning / destructive). */
const Progress = React.forwardRef<
  React.ComponentRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }
>(({ className, value, indicatorClassName, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn('bg-muted relative h-1 w-full overflow-hidden rounded-full', className)}
    value={value}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className={cn(
        'bg-primary h-full w-full flex-1 rounded-full transition-transform duration-500',
        indicatorClassName,
      )}
      style={{ transform: `translateX(-${String(100 - (value ?? 0))}%)` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
