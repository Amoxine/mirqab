'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PageHeader as BasePageHeader, type PageHeaderProps } from '@open-gateway/ui';
import { DocsHelpLink } from '@/components/shared/docs-help-link';
import { docsHelpFor } from '@/lib/docs/contextual';

interface WebPageHeaderProps extends Omit<PageHeaderProps, 'linkComponent'> {
  /** A page whose docs page exists gets a "Help" link in its actions; `false` opts a page out. */
  help?: boolean;
}

/**
 * The shared page header, with the router's `Link` for its back button so navigation stays client-side,
 * and a "Help" link to the page's documentation (see `lib/docs/contextual.ts`), shown first so the
 * page's own primary action stays at the end of the row.
 */
export function PageHeader({ help = true, actions, ...props }: WebPageHeaderProps) {
  const pathname = usePathname();
  const entry = help ? docsHelpFor(pathname) : undefined;
  const merged =
    entry || actions ? (
      <>
        {entry && <DocsHelpLink help={entry} />}
        {actions}
      </>
    ) : undefined;
  return <BasePageHeader linkComponent={Link} actions={merged} {...props} />;
}
