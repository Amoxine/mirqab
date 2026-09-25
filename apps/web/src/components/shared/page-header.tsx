import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PageHeaderProps {
  title: ReactNode;
  /** Status/plan badges shown beside the title. */
  badges?: ReactNode;
  description?: ReactNode;
  /** Primary page actions; they wrap under the title on narrow screens. */
  actions?: ReactNode;
  back?: { href: string; label: string };
}

/**
 * The one page header every dashboard/portal page uses, so title scale, spacing, the back link and
 * how actions wrap at 375px are decided once instead of per page.
 */
export function PageHeader({ title, badges, description, actions, back }: PageHeaderProps) {
  return (
    <div className="space-y-3">
      {back && (
        <Button asChild variant="ghost" size="sm" className="-ms-3 text-muted-foreground hover:text-foreground">
          <Link href={back.href}>
            {/* Points "back" — mirrored in RTL so it doesn't point forward. */}
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
            {back.label}
          </Link>
        </Button>
      )}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="break-words text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
            {badges}
          </div>
          {description && <div className="mt-1 max-w-prose text-sm text-muted-foreground sm:text-base">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}
