import * as React from 'react';
import { cn } from '../lib/utils';

export interface SecretFieldProps extends React.HTMLAttributes<HTMLElement> {
  value: string;
  /** Caption above the value. */
  label?: string;
}

/** A value the user is meant to copy (a key, a client secret, a URL): monospace, one click selects it all. */
export function SecretField({ value, label, className, ...props }: SecretFieldProps) {
  const code = (
    <code
      className={cn('bg-muted block select-all break-all rounded-md p-3 text-sm', className)}
      dir="ltr"
      {...props}
    >
      {value}
    </code>
  );
  if (!label) return code;
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{label}</p>
      {code}
    </div>
  );
}
