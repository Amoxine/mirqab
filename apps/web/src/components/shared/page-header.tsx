import Link from 'next/link';
import { PageHeader as BasePageHeader, type PageHeaderProps } from '@open-gateway/ui';

/** The shared page header, with the router's `Link` for its back button so navigation stays client-side. */
export function PageHeader(props: Omit<PageHeaderProps, 'linkComponent'>) {
  return <BasePageHeader linkComponent={Link} {...props} />;
}
