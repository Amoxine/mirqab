'use client';

import type { ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface MiddlewareCardProps {
  title: string;
  /** One-line current-value summary, e.g. "10 req / 60 s" or "Not configured". */
  summary: ReactNode;
  /** Shown as a small badge next to the title when the section is actively configured. */
  active: boolean;
  activeLabel: string;
  inactiveLabel: string;
  /** Accessible name of the icon-only Edit button — name the section, since 13 cards sit side by side. */
  editLabel: string;
  onEdit?: () => void;
}

/** One middleware section's read-only summary + Edit button, in the Designer tab's grid. Every
 * WP15a-c section renders one of these; `onEdit` opens that section's own Sheet. */
export function MiddlewareCard({
  title,
  summary,
  active,
  activeLabel,
  inactiveLabel,
  editLabel,
  onEdit,
}: MiddlewareCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <Badge variant={active ? 'default' : 'outline'}>{active ? activeLabel : inactiveLabel}</Badge>
        </div>
        {onEdit && (
          <Button type="button" variant="ghost" size="icon" className="-me-2 -mt-2 shrink-0" onClick={onEdit} aria-label={editLabel}>
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <p className="break-words text-sm text-muted-foreground">{summary}</p>
      </CardContent>
    </Card>
  );
}
