import type { ComponentType, ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { cn } from '../lib/utils';

const noticeVariants = cva('flex flex-wrap items-start gap-2 rounded-md border p-3 text-sm sm:flex-nowrap', {
  variants: {
    tone: {
      warning: 'border-warning/50 bg-warning/10',
      info: 'border-info/50 bg-info/10',
      destructive: 'border-destructive/50 bg-destructive/10',
      success: 'border-success/50 bg-success/10',
    },
  },
  defaultVariants: { tone: 'warning' },
});

const ICON: Record<
  NonNullable<VariantProps<typeof noticeVariants>['tone']>,
  ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
> = {
  warning: AlertTriangle,
  info: Info,
  destructive: AlertCircle,
  success: CheckCircle2,
};

const ICON_COLOR = {
  warning: 'text-warning',
  info: 'text-info',
  destructive: 'text-destructive',
  success: 'text-success',
} as const;

export interface NoticeProps extends VariantProps<typeof noticeVariants> {
  /** Bold first line; the children are the explanation below it. */
  title?: ReactNode;
  children?: ReactNode;
  /** A button or link on the end side (retry, review, dismiss). */
  action?: ReactNode;
  /** Replaces the tone's default icon. */
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  /** `status` for something that appears on its own, `alert` for a failure, `note` for static advice. */
  role?: 'status' | 'alert' | 'note';
  className?: string;
}

/** An inline callout: a tinted box with an icon, an optional title, body text and an action. */
export function Notice({
  tone = 'warning',
  title,
  children,
  icon,
  action,
  role,
  className,
}: NoticeProps) {
  const resolved = tone ?? 'warning';
  const Icon = icon ?? ICON[resolved];
  return (
    <div role={role} className={cn(noticeVariants({ tone }), className)}>
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', ICON_COLOR[resolved])} aria-hidden />
      <div className="min-w-0 flex-1 basis-40 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={title ? 'text-muted-foreground' : undefined}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
