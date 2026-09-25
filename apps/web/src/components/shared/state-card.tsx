import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface StateMessageProps {
  icon?: ReactNode;
  title?: string;
  message?: ReactNode;
  /** Next step for the user: retry, create the first item, go back. */
  children?: ReactNode;
  className?: string;
  /** `alert` for errors, so a screen reader announces a failure that replaced the content. */
  role?: 'alert' | 'status';
}

/** Empty / error / not-found body: icon, title, message and the next action, centred. */
export function StateMessage({ icon, title, message, children, className, role }: StateMessageProps) {
  return (
    <div role={role} className={cn('flex flex-col items-center gap-3 px-4 py-10 text-center', className)}>
      {icon && (
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-6">
          {icon}
        </div>
      )}
      {title && <h2 className="text-base font-semibold sm:text-lg">{title}</h2>}
      {message && <div className="max-w-md break-words text-sm text-muted-foreground">{message}</div>}
      {children && <div className="flex flex-wrap justify-center gap-2 pt-1">{children}</div>}
    </div>
  );
}

/** `StateMessage` on a card, for a state that replaces a whole page or section. */
export function StateCard(props: StateMessageProps) {
  return (
    <Card>
      <CardContent className="p-0">
        <StateMessage {...props} className={cn('py-12', props.className)} />
      </CardContent>
    </Card>
  );
}
