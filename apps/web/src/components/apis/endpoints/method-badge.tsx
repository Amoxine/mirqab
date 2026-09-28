import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/** Verb → chip colour. GET green, POST blue, PUT orange, PATCH gold, DELETE red, HEAD teal,
 *  OPTIONS / TRACE / CONNECT gray. Anything else stays gray so a typo doesn't look like a verb. */
const METHOD_VARIANT = {
  GET: 'success',
  POST: 'info',
  PUT: 'warning',
  PATCH: 'patch',
  DELETE: 'destructive',
  HEAD: 'default',
  OPTIONS: 'muted',
  TRACE: 'muted',
  CONNECT: 'muted',
} as const;

/** HTTP method, fixed width so a column of them reads as one; methods are protocol names, never translated. */
export function MethodBadge({ method }: { method: string }) {
  const m = method.toUpperCase();
  const variant = m in METHOD_VARIANT ? METHOD_VARIANT[m as keyof typeof METHOD_VARIANT] : 'muted';
  return (
    <Badge
      variant={variant}
      dir="ltr"
      className="min-w-16 justify-center rounded-md font-mono text-[11px] font-semibold tracking-wide"
    >
      {m}
    </Badge>
  );
}

/** The same warning box `key-form-sheet.tsx` and the analytics empty state use. */
export function WarningNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 space-y-1">{children}</div>
    </div>
  );
}
