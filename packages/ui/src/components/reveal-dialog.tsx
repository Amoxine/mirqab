'use client';

import type { ReactNode } from 'react';
import { Button } from './button';
import { CopyButton } from './copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { SecretField } from './secret-field';

export interface RevealDialogProps {
  /** The secret, held in memory by the caller only. `null` keeps the dialog closed. */
  value: string | null;
  onClose: () => void;
  title: ReactNode;
  description: ReactNode;
  copyLabel: string;
  copiedLabel: string;
  doneLabel: string;
  /** Screen-reader text of the dialog's corner close button. */
  closeLabel?: string;
  onCopyError?: () => void;
  /** `data-testid` of the value, for tests. */
  valueTestId?: string;
  /** More to show under the value (a usage snippet, a warning). */
  children?: ReactNode;
}

/**
 * "Copy this now, it is shown only once": the dialog every freshly minted key or credential
 * appears in. The value exists only in this response — nothing here stores or refetches it.
 */
export function RevealDialog({
  value,
  onClose,
  title,
  description,
  copyLabel,
  copiedLabel,
  doneLabel,
  closeLabel,
  onCopyError,
  valueTestId,
  children,
}: RevealDialogProps) {
  return (
    <Dialog
      open={value !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg" closeLabel={closeLabel}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {value !== null && <SecretField value={value} data-testid={valueTestId} />}
        {children}
        <DialogFooter className="gap-2">
          {value !== null && (
            <CopyButton
              value={value}
              label={copyLabel}
              copiedLabel={copiedLabel}
              onCopyError={onCopyError}
              size="default"
            />
          )}
          <Button type="button" onClick={onClose}>
            {doneLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
