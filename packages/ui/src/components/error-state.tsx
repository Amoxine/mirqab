import { AlertTriangle, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './button';

export interface ErrorStateProps {
  title: string;
  message: string;
  retryLabel: string;
  onRetry: () => void;
  className?: string;
}

/** A failed load that replaced the content: what went wrong and a retry, announced as an alert. */
export function ErrorState({ title, message, retryLabel, onRetry, className }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex h-full min-h-40 flex-col items-center justify-center gap-2 px-4 py-6 text-center',
        className,
      )}
    >
      <AlertTriangle className="text-destructive h-8 w-8" aria-hidden="true" />
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground max-w-md text-sm">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        {retryLabel}
      </Button>
    </div>
  );
}
