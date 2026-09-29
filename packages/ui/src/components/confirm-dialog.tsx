'use client';

import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: ReactNode;
  /** Shown on the confirm button while `isPending`; defaults to `confirmLabel`. */
  pendingLabel?: ReactNode;
  cancelLabel: ReactNode;
  /** The action is running: the dialog cannot be dismissed and both buttons are disabled. */
  isPending?: boolean;
  /** Runs when the user confirms. The dialog stays open — close it from here when the action settles. */
  onConfirm: () => void | Promise<void>;
  /** `destructive` for delete / revoke / remove; `default` for a confirmation that is not irreversible. */
  tone?: 'destructive' | 'default';
  /** Extra classes for both footer buttons (e.g. a larger touch target). */
  buttonClassName?: string;
  /** Extra body content under the description (a checkbox, a warning). */
  children?: ReactNode;
}

/**
 * The confirmation every risky action goes through. Radix closes an AlertDialog the moment the
 * action button is pressed; this holds it open until the caller's work settles, and refuses to be
 * dismissed while that work is in flight.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel,
  cancelLabel,
  isPending = false,
  onConfirm,
  tone = 'destructive',
  buttonClassName,
  children,
}: ConfirmDialogProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!isPending) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending} className={buttonClassName}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            aria-busy={isPending || undefined}
            className={cn(
              tone === 'destructive' &&
                'bg-destructive text-destructive-foreground hover:bg-destructive/90',
              buttonClassName,
            )}
            onClick={(event) => {
              event.preventDefault();
              void onConfirm();
            }}
          >
            {isPending ? (pendingLabel ?? confirmLabel) : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
