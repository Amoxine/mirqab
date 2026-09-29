'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button, type ButtonProps } from './button';

export interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children' | 'value'> {
  /** The text put on the clipboard. */
  value: string;
  /** Visible label. With `iconOnly` it is the accessible name instead. */
  label: string;
  /** Label after a successful copy. Default: `label`. */
  copiedLabel?: string;
  /** Called when the browser refuses the write (no permission, insecure context). */
  onCopyError?: () => void;
  /** Show only the icon; `label` becomes the aria-label. */
  iconOnly?: boolean;
  /** Return to the idle state this long after copying. Default: stay "copied". */
  resetAfterMs?: number;
}

/** A button that copies `value` and confirms with a check mark. It forgets it copied when `value` changes. */
export function CopyButton({
  value,
  label,
  copiedLabel,
  onCopyError,
  iconOnly = false,
  resetAfterMs,
  variant = 'outline',
  size = 'sm',
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    setCopied(false);
  }, [value]);

  React.useEffect(() => {
    if (!copied || resetAfterMs === undefined) return;
    const id = window.setTimeout(() => {
      setCopied(false);
    }, resetAfterMs);
    return () => {
      window.clearTimeout(id);
    };
  }, [copied, resetAfterMs]);

  const Icon = copied ? Check : Copy;
  return (
    <Button
      type="button"
      variant={variant}
      size={iconOnly ? 'icon' : size}
      aria-label={iconOnly ? label : undefined}
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
          },
          () => {
            onCopyError?.();
          },
        );
      }}
      {...props}
    >
      <Icon aria-hidden="true" />
      {!iconOnly && (copied ? (copiedLabel ?? label) : label)}
    </Button>
  );
}
